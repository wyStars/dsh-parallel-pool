/**
 * dsh-parallel-pool — 动态滚动窗口子代理任务池（工具包形态，纯 ESM JS）。
 *
 * 要解决的问题：主对话用 subagent 并发执行一批任务时，需要等"整轮"所有
 * 子代理结束才开始下一轮派发，慢任务拖慢全批（轮次屏障）。
 *
 * 本插件提供 parallel_pool 工具：一次调用传入任务列表 + 并发上限，内部
 * 实现滚动窗口调度——任何子代理一结束立刻补位下一个任务（不等整轮），
 * 全部结算后一次性返回每个任务的结果与起止时间线。
 *
 * 实现要点（对齐官方 tool-subagent 模式）：
 * - 经 ctx.subagents.start(provider, {label, prompt, parent, signal}) 派生
 *   一次性子代理；run.result 结算 {stopReason, output}，run.dispose() 释放。
 * - 结算回调里触发 refill()：active < maxConcurrency 且队列非空即补位。
 * - 所有注册挂 ctx.effect：fiber dispose（卸载/热重载）自动清理。
 * - exec.signal 中止时停止补位并立即返回部分结果（in-flight 子代理被
 *   信号传播中止）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-parallel-pool'
export const inject = ['tools', 'subagents']

/** 插件默认配置（无外部配置时按此工作）。 */
const DEFAULTS = Object.freeze({
  toolName: 'parallel_pool',
  defaultProvider: 'spawn', // 全新子代理；'fork' 继承对话
  defaultMaxConcurrency: 4,
  maxTasks: 64,
  maxConcurrencyCap: 16,
  perTaskOutputChars: 4000,
  budgetChars: 150_000, // 结果总预算，超出按任务均摊截断
  maxDepth: 3, // 子代理递归派生深度上限（spawn/fork provider 均支持）
})

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS }
  if (config === void 0 || config === null) return cfg
  for (const key of Object.keys(DEFAULTS)) {
    if (config[key] !== void 0) cfg[key] = config[key]
  }
  return cfg
}

/** 中止错误（对齐官方工具对 abort 的词汇）。 */
function abortError() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

/** 把 stopReason 归一化为结果状态。 */
function normalizeStatus(stopReason) {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'max-tokens': return 'failed'
    case 'refusal': return 'failed'
    case 'error': return 'failed'
    default: return 'failed'
  }
}

function stopReasonError(stopReason) {
  switch (stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(stopReason)})`
  }
}

/** 从内容块数组抽取纯文本。 */
function joinText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function validateArgs(args) {
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    throw new Error('parallel_pool: `tasks` must be a non-empty array')
  }
  if (args.tasks.length > DEFAULTS.maxTasks) {
    throw new Error(`parallel_pool: at most ${DEFAULTS.maxTasks} tasks per call, got ${args.tasks.length}`)
  }
  args.tasks.forEach((task, index) => {
    if (task === null || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`parallel_pool: tasks[${index}] must be an object`)
    }
    if (typeof task.prompt !== 'string' || task.prompt.trim().length === 0) {
      throw new Error(`parallel_pool: tasks[${index}].prompt must be a non-empty string`)
    }
    if (task.description !== void 0 && (typeof task.description !== 'string' || task.description.trim().length === 0)) {
      throw new Error(`parallel_pool: tasks[${index}].description must be a non-empty string when present`)
    }
    if (task.model !== void 0 && (typeof task.model !== 'string' || task.model.trim().length === 0)) {
      throw new Error(`parallel_pool: tasks[${index}].model must be a non-empty string when present`)
    }
  })
  if (args.maxConcurrency !== void 0) {
    const n = Number(args.maxConcurrency)
    if (!Number.isInteger(n) || n < 1 || n > DEFAULTS.maxConcurrencyCap) {
      throw new Error(`parallel_pool: maxConcurrency must be an integer in 1..${DEFAULTS.maxConcurrencyCap}`)
    }
  }
  if (args.provider !== void 0 && typeof args.provider !== 'string') {
    throw new Error('parallel_pool: provider must be a string when present')
  }
  if (args.failFast !== void 0 && typeof args.failFast !== 'boolean') {
    throw new Error('parallel_pool: failFast must be a boolean when present')
  }
}

/** 结果总量预算：超出后按任务均摊截断。 */
function enforceBudget(entries, budget) {
  let total = 0
  for (const entry of entries) total += entry.output !== void 0 ? entry.output.length : 0
  if (total <= budget) return false
  const allowance = Math.max(200, Math.floor(budget / Math.max(1, entries.length)) - 60)
  for (const entry of entries) {
    if (entry.output !== void 0 && entry.output.length > allowance) {
      entry.output = `${entry.output.slice(0, allowance)}\n[truncated: output was ${entry.output.length} chars]`
      entry.truncated = true
    }
  }
  return true
}

/** 等待 subagent/end 事件给出 runId → 子会话 id 映射（上限 2s，轮询 50ms）。 */
async function waitForEnd(endByRun, runId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const info = endByRun.get(runId)
    if (info !== undefined) return info
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return undefined
}

/**
 * 从已持久化的子会话日志读 turn/end 底层错误（如 402 余额不足、无适配器等）。
 * 仅失败任务调用；读取失败返回 undefined，不掩盖任务结果。
 */
async function childFailureDetail(ctx, sessionId) {
  if (sessionId === undefined) return undefined
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery === undefined || typeof sessionQuery.readSession !== 'function') return undefined
  try {
    const snapshot = await sessionQuery.readSession(sessionId)
    const events = (snapshot && (snapshot.events || (snapshot.session && snapshot.session.events))) || []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event === null || typeof event !== 'object') continue
      if (event.type !== 'turn/end' && event.eventType !== 'turn/end') continue
      const reason = (event.data || event.payload || {}).reason
      if (reason === undefined || reason === null || typeof reason !== 'object') continue
      const error = reason.error || reason.failure
      if (error === undefined || error === null) continue
      const message = typeof error === 'string' ? error : error.message
      if (typeof message === 'string' && message.length > 0) return message.slice(0, 300)
    }
  } catch { /* 详情读取失败不掩盖任务结果 */ }
  return undefined
}

/** 渲染一行结果（render 用）。 */
function renderResultLine(entry) {
  const icon = entry.status === 'completed' ? '✔' : entry.status === 'skipped' ? '·' : '✘'
  const seconds = (entry.durationMs / 1000).toFixed(1)
  const note = entry.error !== void 0 ? ` — ${entry.error}` : ''
  return `#${entry.index + 1} ${entry.description} ${icon} ${entry.status} ${seconds}s${note}`
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)

  // 子会话 id 登记（subagent/end 的 info.id 即会话 id）：失败任务据此回读底层错误详情。
  const endByRun = new Map()
  ctx.effect(() => ctx.on('subagent/end', (info) => {
    if (info === null || typeof info !== 'object' || typeof info.id !== 'string') return
    endByRun.set(info.id, { sessionId: info.id })
    if (endByRun.size > 256) endByRun.delete(endByRun.keys().next().value)
  }), 'dsh-parallel-pool: subagent/end listener')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: cfg.toolName,
    description:
      'Run a batch of independent tasks through a dynamic pool of subagents: launches up to maxConcurrency subagents and immediately backfills the next queued task as soon as any one finishes (rolling window, no round barriers), then returns every result with per-task timing. Use it instead of several rounds of subagent calls when you have 2+ independent tasks: one call, minimal makespan.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: `Up to ${cfg.maxTasks} independent task specs, executed in submission order.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            prompt: {
              type: 'string',
              required: true,
              description: 'Complete, self-contained task prompt. The child shares your workspace but not this conversation, so include everything it needs.',
            },
            description: {
              type: 'string',
              description: 'Short (3-5 word) label for display.',
            },
            model: {
              type: 'string',
              description: 'Optional model override for this child.',
            },
          },
        },
      },
      maxConcurrency: {
        type: 'integer',
        description: `Maximum in-flight subagents (rolling window size). Default ${cfg.defaultMaxConcurrency}; 1..${cfg.maxConcurrencyCap}.`,
      },
      provider: {
        type: 'string',
        description: `Subagent provider: 'spawn' (fresh child, default) or 'fork' (inherits this conversation).`,
      },
      failFast: {
        type: 'boolean',
        description: 'Stop starting new tasks after the first failure; in-flight tasks still finish. Default false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          completed: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          aborted: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          durationMs: { type: 'integer', required: true },
          maxConcurrencyUsed: { type: 'integer', required: true },
          provider: { type: 'string', required: true },
          rollingRefill: { type: 'boolean', required: true },
          resultsTruncated: { type: 'boolean', required: true },
          callAborted: { type: 'boolean', required: true },
          results: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: true },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `parallel_pool: ${value.completed}/${value.total} completed in ${(value.durationMs / 1000).toFixed(1)}s (provider ${value.provider}, peak concurrency ${value.maxConcurrencyUsed}, rolling refill ${value.rollingRefill ? 'active' : 'not needed'})`,
        ]
        if (value.failed > 0 || value.aborted > 0 || value.skipped > 0) {
          lines.push(`outcomes: ${value.failed} failed, ${value.aborted} aborted, ${value.skipped} skipped`)
        }
        for (const entry of value.results) lines.push(`  ${renderResultLine(entry)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `pool: ${args.tasks.length} tasks × ${args.maxConcurrency ?? cfg.defaultMaxConcurrency}`,
      kind: 'execute',
      rawInput: `parallel_pool ${args.tasks.length} tasks`,
    }),
    async execute(args, exec) {
      validateArgs(args)
      const parent = exec.agent
      if (parent === void 0) throw new Error('parallel_pool requires a calling agent (exec.agent was undefined)')
      if (exec.signal !== void 0 && exec.signal.aborted) throw abortError()

      const tasks = args.tasks
      const maxConcurrency = clamp(args.maxConcurrency ?? cfg.defaultMaxConcurrency, 1, cfg.maxConcurrencyCap)
      const failFast = args.failFast === true

      // Provider 解析：显式指定必须存在；否则 defaultProvider → 'spawn' → 第一个。
      let provider
      {
        const names = ctx.subagents.list()
        if (args.provider !== void 0) {
          if (!names.includes(args.provider)) throw new Error(`parallel_pool: subagent provider "${args.provider}" is not registered (available: ${names.join(', ')})`)
          provider = args.provider
        } else {
          provider = names.includes(cfg.defaultProvider) ? cfg.defaultProvider : names.includes('spawn') ? 'spawn' : names[0]
          if (provider === void 0) throw new Error('parallel_pool: no subagent provider registered')
        }
      }

      const results = new Array(tasks.length)
      const startedAt = Date.now()
      // spawn 路径要求 request.signal 存在：缺失时提供一次性独立控制器（防 start 崩溃）。
      const signal = exec.signal !== void 0 ? exec.signal : new AbortController().signal
      let next = 0
      let active = 0
      let peakActive = 0
      let settled = 0
      let stopRefill = false
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })

      const maybeFinish = () => {
        if (settled === tasks.length || (stopRefill && active === 0)) resolveDone()
      }

      const launch = (index) => {
        const task = tasks[index]
        const label = task.description ?? `pool-task-${index + 1}`
        const t0 = Date.now()
        active += 1
        peakActive = Math.max(peakActive, active)
        return (async () => {
          let entry
          let runId
          try {
            const run = await ctx.subagents.start(provider, {
              label,
              prompt: [{ type: 'text', text: task.prompt }],
              parent,
              ...(task.model !== void 0 ? { agentOptions: { model: task.model } } : {}),
              signal,
              maxDepth: cfg.maxDepth,
            })
            runId = run.id
            try {
              const result = await run.result
              const stopReason = result !== null && typeof result === 'object' ? result.stopReason ?? 'completed' : 'completed'
              const text = joinText(result !== null && typeof result === 'object' ? result.output : [])
              const status = normalizeStatus(stopReason)
              entry = {
                index,
                description: label,
                status,
                startedAt: new Date(t0).toISOString(),
                endedAt: new Date().toISOString(),
                durationMs: Date.now() - t0,
              }
              if (status !== 'completed') entry.error = stopReasonError(stopReason)
              if (text.length > 0) entry.output = text.slice(0, cfg.perTaskOutputChars) + (text.length > cfg.perTaskOutputChars ? `\n[truncated: output was ${text.length} chars]` : '')
              results[index] = entry
              if (status !== 'completed' && failFast) stopRefill = true
            } finally {
              try { await run.dispose() } catch { /* 释放失败不掩盖任务结果 */ }
            }
            // 失败任务回读底层错误（如 402 余额不足），避免把外部故障误判成插件问题。
            if (entry !== undefined && entry.status === 'failed') {
              const endInfo = await waitForEnd(endByRun, runId, 1000)
              const detail = await childFailureDetail(ctx, endInfo !== undefined ? endInfo.sessionId : runId)
              if (detail !== undefined) entry.error = `${entry.error}: ${detail}`
              if (endInfo !== undefined) endByRun.delete(runId)
            }
          } catch (error) {
            results[index] = {
              index,
              description: label,
              status: 'failed',
              startedAt: new Date(t0).toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: Date.now() - t0,
              error: error instanceof Error ? error.message : String(error),
            }
            if (failFast) stopRefill = true
          }
        })().finally(() => {
          active -= 1
          settled += 1
          refill()
        })
      }

      const refill = () => {
        if (stopRefill) {
          maybeFinish()
          return
        }
        while (next < tasks.length && active < maxConcurrency) {
          const index = next
          next += 1
          void launch(index)
        }
        maybeFinish()
      }

      refill()

      // 中止：停止补位、立即返回部分结果；in-flight 子代理由信号传播中止。
      const aborted = new Promise((resolve) => {
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      const race = await Promise.race([done.then(() => 'done'), aborted.then(() => 'aborted')])
      const callAborted = race === 'aborted' || signal.aborted
      if (callAborted) stopRefill = true

      // 汇总：未启动的任务标记 skipped，保证每个任务都有结局。
      const entries = tasks.map((task, index) => results[index] ?? {
        index,
        description: task.description ?? `pool-task-${index + 1}`,
        status: 'skipped',
        durationMs: 0,
      })
      let completed = 0
      let failed = 0
      let abortedCount = 0
      let skipped = 0
      for (const entry of entries) {
        if (entry.status === 'completed') completed += 1
        else if (entry.status === 'aborted') abortedCount += 1
        else if (entry.status === 'skipped') skipped += 1
        else failed += 1
      }
      const resultTruncated = enforceBudget(entries, cfg.budgetChars)

      // 滚动补位证据：存在"后启动"任务早于"先启动"任务结束时开始。
      const settledEntries = entries.filter((e) => e.startedAt !== void 0 && e.endedAt !== void 0)
      let rollingRefill = false
      for (let i = 1; i < settledEntries.length && !rollingRefill; i += 1) {
        for (let j = 0; j < i; j += 1) {
          if (settledEntries[i].startedAt < settledEntries[j].endedAt) {
            rollingRefill = true
            break
          }
        }
      }

      return {
        total: tasks.length,
        completed,
        failed,
        aborted: abortedCount,
        skipped,
        durationMs: Date.now() - startedAt,
        maxConcurrencyUsed: peakActive,
        provider,
        rollingRefill,
        resultsTruncated: resultTruncated,
        callAborted,
        results: entries,
      }
    },
  })), 'dsh-parallel-pool: parallel_pool tool')
}
