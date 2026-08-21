/**
 * dsh-parallel-pool — 动态滚动窗口子代理任务池（工具包形态，纯 ESM JS）。
 *
 * 目标：把"整批独立任务"一次交给任务池，主对话不阻塞：
 * - 后台模式（默认）：提交即返回 job id；池内滚动窗口补位——任何子代理
 *   一结束立刻派发下一任务（不等整轮）；全批结算后把完整结果与时间线
 *   作为会话消息投递、唤醒主对话（对齐 dsh-shell-callback 回调模式）。
 * - 前台模式（background: false）：等待整批完成，结果内联返回。
 *
 * 性能设计（v0.4.0）：工作器池——持久子代理数 = 并发数而非任务数。
 * 每个 worker 串行处理任务（首任务随创建派发，后续经 subagents.followup），
 * 每任务一回合、subagent/end 逐回合结算。Web 会话回显与子代理目录的
 * 加载负载不再随任务数增长（实测 189 个子代理 → listChildren 13.6s，
 * 每冷子代理折叠 ~68ms）。
 *
 * 实现要点：
 * - 经 ctx.subagents.startContinuable({provider, label, request, signal}) 派生
 *   continuable 子代理（对齐默认 subagent 工具：面板实时可见、可续跑、原生
 *   完成通知）；subagent/end 事件结算 {stopReason, lastAssistantMessage}。
 * - worker 失败/中止即停，不再领取后续任务；failFast 停止全局派发。
 * - 后台 job 无主注册（对齐 shell-callback：tool-jobs 监听器对无主 job
 *   直接 return，本插件 onJobDone 回调成为唯一通知者，避免双通知）；
 *   global 层 attachController 使无主 start 通过前置检查。
 * - 所有注册挂 ctx.effect：fiber dispose（卸载/热重载）自动清理。
 * - 失败任务经 subagent/end 定位子会话，回读 turn/end 底层错误（如 402
 *   余额不足）并入结果 error 字段，避免外部故障被误判为插件问题。
 * - 中止时 stopDispatch + 逐个 interrupt in-flight 子代理，并有 1s 宽限期
 *   等待 worker 记录已结算任务的结果。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-parallel-pool'
export const inject = ['tools', 'subagents', 'jobs', 'systemPrompt']

/** 插件默认配置（无外部配置时按此工作）。 */
const DEFAULTS = Object.freeze({
  toolName: 'parallel_pool',
  defaultProvider: 'spawn', // 全新子代理；'fork' 继承对话
  defaultMaxConcurrency: 4,
  backgroundDefault: true, // 默认后台：返回 job id，结果会话消息投递
  maxTasks: 64,
  maxConcurrencyCap: 16,
  perTaskOutputChars: 4000,
  budgetChars: 150_000, // 结果总预算，超出按任务均摊截断
  noticeMaxChars: 48_000, // 会话投递消息上限，超出截断并提示 job_output
  maxDepth: 3, // 子代理递归派生深度上限（spawn/fork provider 均支持）
  promptSectionOrder: 110, // 引导段顺序：早于 tool-subagent（116.5）以优先采用
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
    if (task.description !== void 0 && typeof task.description !== 'string') {
      throw new Error(`parallel_pool: tasks[${index}].description must be a string when present`)
    }
    if (task.model !== void 0 && typeof task.model !== 'string') {
      throw new Error(`parallel_pool: tasks[${index}].model must be a string when present`)
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
  if (args.background !== void 0 && typeof args.background !== 'boolean') {
    throw new Error('parallel_pool: background must be a boolean when present')
  }
}

/** 清洗任务列表：model/description 空字符串视为未提供（模型常传 model:""）。 */
function sanitizeTasks(tasks) {
  return tasks.map((task) => {
    const out = { ...task }
    if (typeof out.model === 'string') {
      const trimmed = out.model.trim()
      out.model = trimmed.length > 0 ? trimmed : undefined
    }
    if (typeof out.description === 'string') {
      const trimmed = out.description.trim()
      out.description = trimmed.length > 0 ? trimmed : undefined
    }
    return out
  })
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

/**
 * 等待 continuable 子代理结算：轮询 subagent/end 登记（200ms 间隔），
 * 信号中止时立即返回 aborted 终态。返回该子代理的结算信息。
 */
async function waitForChildEnd(endByRun, childId, signal) {
  let abortResolve
  const onAbort = () => { if (abortResolve !== undefined) abortResolve() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const info = endByRun.get(childId)
      if (info !== undefined) return info // 先查已登记结果：kill 前完成的任务记为 completed
      if (signal.aborted) return { sessionId: childId, stopReason: 'aborted', lastAssistantMessage: [] }
      await new Promise((resolve) => {
        abortResolve = resolve
        setTimeout(resolve, 200)
      })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
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

/** 渲染一行结果。 */
function renderResultLine(entry) {
  const icon = entry.status === 'completed' ? '✔' : entry.status === 'skipped' ? '·' : '✘'
  const seconds = (entry.durationMs / 1000).toFixed(1)
  const note = entry.error !== void 0 ? ` — ${entry.error}` : ''
  return `#${entry.index + 1} ${entry.description} ${icon} ${entry.status} ${seconds}s${note}`
}

/** 实时进度文本（job readOutput 用）：已结算任务逐行 + 计数。 */
function renderProgressText(results, settled, total) {
  const lines = [`parallel_pool progress: ${settled}/${total} settled`]
  for (let i = 0; i < results.length; i += 1) {
    const entry = results[i]
    if (entry !== undefined) lines.push(`  ${renderResultLine(entry)}`)
  }
  return lines.join('\n')
}

/** 汇总渲染为多行文本（render 与会话投递共用）。 */
function renderSummaryLines(summary) {
  const lines = [
    `parallel_pool: ${summary.completed}/${summary.total} completed in ${(summary.durationMs / 1000).toFixed(1)}s (provider ${summary.provider}, peak concurrency ${summary.maxConcurrencyUsed}, rolling refill ${summary.rollingRefill ? 'active' : 'not needed'})`,
  ]
  if (summary.failed > 0 || summary.aborted > 0 || summary.skipped > 0) {
    lines.push(`outcomes: ${summary.failed} failed, ${summary.aborted} aborted, ${summary.skipped} skipped`)
  }
  for (const entry of summary.results) lines.push(`  ${renderResultLine(entry)}`)
  return lines
}

/** 池引擎：滚动窗口调度整批任务，全部结算（或中止）后返回汇总。 */
export async function runPool(ctx, cfg, engine) {
  const { tasks, maxConcurrency, provider, failFast, parent, signal, endByRun, onProgress } = engine
  const results = new Array(tasks.length)
  const startedAt = Date.now()
  const activeChildren = new Set() // in-flight continuable 子会话 id（中止时逐个 interrupt）
  let next = 0
  let peakActive = 0
  let settled = 0
  let stopDispatch = false
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  const maybeFinish = () => {
    if (settled === tasks.length || (stopDispatch && activeChildren.size === 0)) resolveDone()
  }

  /** 领取下一个任务下标；无任务/停发时返回 -1。 */
  const claim = () => {
    if (stopDispatch || signal.aborted || next >= tasks.length) return -1
    const index = next
    next += 1
    return index
  }

  /** 等待单个任务回合结算并构建结果条目。 */
  const settleOne = async (task, index, childId, t0) => {
    const end = await waitForChildEnd(endByRun, childId, signal)
    endByRun.delete(childId)
    const stopReason = end.stopReason ?? 'completed'
    const text = joinText(end.lastAssistantMessage)
    const status = normalizeStatus(stopReason)
    const entry = {
      index,
      description: task.description ?? `pool-task-${index + 1}`,
      status,
      startedAt: new Date(t0).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    }
    if (status !== 'completed') entry.error = stopReasonError(stopReason)
    if (text.length > 0) entry.output = text.slice(0, cfg.perTaskOutputChars) + (text.length > cfg.perTaskOutputChars ? `\n[truncated: output was ${text.length} chars]` : '')
    // 失败任务回读底层错误（如 402 余额不足），避免把外部故障误判成插件问题。
    if (status === 'failed') {
      const detail = await childFailureDetail(ctx, childId)
      if (detail !== undefined) entry.error = `${entry.error}: ${detail}`
    }
    return entry
  }

  const failedEntry = (index, t0, error) => ({
    index,
    description: index >= 0 ? (tasks[index].description ?? `pool-task-${index + 1}`) : `pool-task`,
    status: signal.aborted ? 'aborted' : 'failed',
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    error: signal.aborted ? 'batch aborted' : error instanceof Error ? error.message : String(error),
  })

  /** 结算一个任务并登记进度。 */
  const record = (entry) => {
    results[entry.index] = entry
    settled += 1
    peakActive = Math.max(peakActive, activeChildren.size)
    if (onProgress !== undefined) onProgress(renderProgressText(results, settled, tasks.length))
    if (entry.status !== 'completed' && failFast) stopDispatch = true
    maybeFinish()
  }

  /**
   * 单个工作器：一个持久子代理串行处理任务（每任务一次 followup 回合）。
   * 性能设计（v0.4.0）：子代理数 = 并发数而非任务数——每批只产生
   * maxConcurrency 个子会话，Web 会话回显与子代理目录的负载不再随任务数增长。
   */
  const runWorker = async (workerIndex) => {
    const workerLabel = `pool worker ${workerIndex + 1}`
    let childId
    const firstIndex = claim()
    if (firstIndex < 0) return
    const firstTask = tasks[firstIndex]
    const firstT0 = Date.now()
    try {
      const start = await ctx.subagents.startContinuable({
        provider,
        label: workerLabel,
        request: {
          label: workerLabel,
          prompt: [{ type: 'text', text: firstTask.prompt }],
          parent,
          ...(firstTask.model !== void 0 ? { agentOptions: { model: firstTask.model } } : {}),
          maxDepth: cfg.maxDepth,
        },
        signal,
      })
      childId = start.childId
      activeChildren.add(childId)
      record(await settleOne(firstTask, firstIndex, childId, firstT0))
      // 后续任务：followup 派发，逐任务结算；worker 失败/中止即停。
      for (;;) {
        const index = claim()
        if (index < 0) break
        const task = tasks[index]
        const t0 = Date.now()
        try {
          await ctx.subagents.followup(parent, childId, [{ type: 'text', text: task.prompt }], {
            source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
            signal,
          })
          const entry = await settleOne(task, index, childId, t0)
          record(entry)
          if (entry.status !== 'completed') break
        } catch (error) {
          record(failedEntry(index, t0, error))
          break
        }
      }
    } catch (error) {
      record(failedEntry(firstIndex, firstT0, error))
    } finally {
      if (childId !== undefined) activeChildren.delete(childId)
      maybeFinish()
    }
  }

  const workerCount = Math.min(maxConcurrency, tasks.length)
  for (let i = 0; i < workerCount; i += 1) void runWorker(i)
  maybeFinish()

  // 中止：停止派发、立即返回部分结果；in-flight 子代理由 interrupt 中断。
  const aborted = new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  const race = await Promise.race([done.then(() => 'done'), aborted.then(() => 'aborted')])
  const callAborted = race === 'aborted' || signal.aborted
  if (callAborted) {
    stopDispatch = true
    for (const id of activeChildren) {
      try { ctx.subagents.interrupt(id, parent) } catch { /* 尽力而为 */ }
    }
    // 宽限期：等 in-flight worker 记录已结算任务的结果（最多 1s），避免丢失。
    const graceDeadline = Date.now() + 1000
    while (activeChildren.size > 0 && Date.now() < graceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

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
}

/** 会话投递消息（结果通知），超出上限截断并提示 job_output。 */
function fitNotice(jobId, summary, cfg) {
  const text = renderSummaryLines(summary).join('\n')
  const head = `parallel_pool job ${jobId} finished [${summary.completed}/${summary.total} completed, ${summary.failed} failed, ${summary.aborted} aborted, ${summary.skipped} skipped]`
  const full = `${head}:\n${text}`
  if (full.length <= cfg.noticeMaxChars) return full
  return `${full.slice(0, cfg.noticeMaxChars)}\n[notice truncated — read the full results with job_output ${jobId}]`
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)

  // 子会话结算登记（subagent/end 的 info.id 即会话 id）：
  // continuable 子代理结算时登记 stopReason 与最终消息，池据此取结果。
  const endByRun = new Map()
  ctx.effect(() => ctx.on('subagent/end', (info) => {
    if (info === null || typeof info !== 'object' || typeof info.id !== 'string') return
    endByRun.set(info.id, {
      sessionId: info.id,
      stopReason: info.stopReason,
      lastAssistantMessage: Array.isArray(info.lastAssistantMessage) ? info.lastAssistantMessage : [],
    })
    if (endByRun.size > 256) endByRun.delete(endByRun.keys().next().value)
  }), 'dsh-parallel-pool: subagent/end listener')

  // jobId → { agent, state }：结算回调据此把结果投递回发起会话。
  const poolJobs = new Map()
  ctx.effect(() => ctx.jobs.onJobDone((snapshot, _owner) => {
    const entry = poolJobs.get(snapshot.id)
    if (entry === undefined) return // 不是本插件的 job
    poolJobs.delete(snapshot.id)
    // 模型已通过 job_output(wait)/job_kill 拿到终态：不重复投递。
    if (snapshot.reported) return
    const summary = entry.state.summary
    if (summary === undefined) return // 引擎早退无结果：不投递空消息
    const message = createUserMessage({
      content: [{ type: 'text', text: fitNotice(snapshot.id, summary, cfg) }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-parallel-pool',
        form: 'notice',
        summary: `pool ${summary.completed}/${summary.total}`.slice(0, 40),
      },
    })
    const agent = entry.agent
    try {
      if (agent.status === 'idle') agent.followup(message)
      else agent.inject(message)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-parallel-pool: delivery failed for ${snapshot.id}: ${String(error)}`)
    }
  }), 'dsh-parallel-pool: job done callback')

  // 控制器声明：无主 job 的 start 要求 global 层有控制器（对齐 shell-callback）。
  ctx.effect(() => ctx.jobs.attachController('dsh-parallel-pool'), 'dsh-parallel-pool: job controller')

  // 引导段：让模型对 2+ 独立任务默认整批交给任务池，而不是手动逐波派发。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:parallel_pool',
    order: cfg.promptSectionOrder,
    text: 'For 2+ independent tasks, submit the whole batch to parallel_pool in ONE call instead of fanning out manual subagent waves. It runs in the background by default: returns a job id immediately (your turn does not block) and dispatches subagents with a rolling window — each finished task is immediately replaced by the next queued task, so slow tasks never stall the batch. Keep working on independent steps; the complete per-task results and timing arrive as an in-session message when the batch settles. job_output shows live per-task progress; job_kill stops the batch and partial results are still delivered. Prefer the background default even when later work depends on the results — reserve background: false for small, fast batches only.',
  }), 'dsh-parallel-pool: prompt section')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: cfg.toolName,
    description:
      'Submit a batch of independent tasks to a dynamic subagent pool. The pool dispatches up to maxConcurrency subagents with a rolling window — as soon as any task finishes, the next queued task starts immediately (no round barriers), so slow tasks never stall the batch. Runs in the background by default: returns a job id at once and delivers the complete per-task results and timing as an in-session message when the batch settles; the turn does not block. job_output shows live per-task progress; job_kill stops the batch. Prefer the background default even when later work depends on the results; reserve background: false for small, fast batches.',
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
      background: {
        type: 'boolean',
        description: `Run as a background job: return a job id immediately and receive the full results as an in-session message when the batch settles. Default ${cfg.backgroundDefault}. Set false to wait for the results inline.`,
      },
    },
    output: {
      schema: { oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'background' },
            jobId: { type: 'string', required: true },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'foreground' },
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
            results: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          },
        },
      ] },
      render: (_args, value) => value.kind === 'background'
        ? [{ type: 'text', text: `parallel_pool: batch submitted as background job ${value.jobId} — the dynamic pool is running with rolling refill; the complete results will arrive as an in-session message when the batch settles. Keep working on independent steps. (job_output shows live per-task progress; job_kill stops the batch.)` }]
        : [{ type: 'text', text: renderSummaryLines(value).join('\n') }],
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `pool: ${args.tasks.length} tasks × ${args.maxConcurrency ?? cfg.defaultMaxConcurrency}${args.background === false ? '' : ' (bg)'}`,
      kind: 'execute',
      rawInput: `parallel_pool ${args.tasks.length} tasks`,
    }),
    async execute(args, exec) {
      validateArgs(args)
      const parent = exec.agent
      if (parent === void 0) throw new Error('parallel_pool requires a calling agent (exec.agent was undefined)')
      if (exec.signal !== void 0 && exec.signal.aborted) throw abortError()

      const tasks = sanitizeTasks(args.tasks)
      const maxConcurrency = clamp(args.maxConcurrency ?? cfg.defaultMaxConcurrency, 1, cfg.maxConcurrencyCap)
      const failFast = args.failFast === true
      const background = args.background ?? cfg.backgroundDefault

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

      if (background) {
        const state = {
          summary: undefined,
          progressText: `parallel_pool progress: 0/${tasks.length} settled`,
        }
        const jobId = ctx.jobs.start({
          kind: 'parallel-pool',
          label: `pool: ${tasks.length} tasks`,
          run: () => {
            const controller = new AbortController()
            return {
              cancel: (reason) => {
                controller.abort(reason ?? 'parallel_pool job killed')
              },
              // job_output 实时进度/终态富文本：每任务结算即更新。
              readOutput: () => state.progressText,
              done: runPool(ctx, cfg, {
                tasks,
                maxConcurrency,
                provider,
                failFast,
                parent,
                signal: controller.signal,
                endByRun,
                onProgress: (text) => { state.progressText = text },
              }).then((summary) => {
                state.summary = summary
                state.progressText = renderSummaryLines(summary).join('\n')
                return summary.callAborted
                  ? { status: 'killed', detail: `${summary.completed}/${summary.total} completed before kill` }
                  : { status: 'completed', detail: `${summary.completed}/${summary.total} completed` }
              }).catch((error) => {
                state.summary = {
                  total: tasks.length,
                  completed: 0,
                  failed: tasks.length,
                  aborted: 0,
                  skipped: 0,
                  durationMs: 0,
                  maxConcurrencyUsed: 0,
                  provider,
                  rollingRefill: false,
                  resultsTruncated: false,
                  callAborted: true,
                  engineError: error instanceof Error ? error.message : String(error),
                  results: tasks.map((task, index) => ({
                    index,
                    description: task.description ?? `pool-task-${index + 1}`,
                    status: 'failed',
                    durationMs: 0,
                    error: error instanceof Error ? error.message : String(error),
                  })),
                }
                state.progressText = `parallel_pool engine error: ${error instanceof Error ? error.message : String(error)}`
                return { status: 'failed', detail: String(error instanceof Error ? error.message : error).slice(0, 200) }
              }),
            }
          },
        })
        poolJobs.set(jobId, { agent: parent, state })
        return { kind: 'background', jobId }
      }

      const signal = exec.signal !== void 0 ? exec.signal : new AbortController().signal
      const summary = await runPool(ctx, cfg, {
        tasks,
        maxConcurrency,
        provider,
        failFast,
        parent,
        signal,
        endByRun,
      })
      return { kind: 'foreground', ...summary }
    },
  })), 'dsh-parallel-pool: parallel_pool tool')
}
