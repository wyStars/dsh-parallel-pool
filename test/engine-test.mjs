// dsh-parallel-pool 工作器池引擎离线单元测试（mock ctx，不触碰运行时）。
// 覆盖：基础调度（A）、failFast（B）、中止（C）、单任务超时+重试耗尽（D）、
// 重试成功（E）、worker 轮换（F）、轮换上限语义（G）。
import { runPool } from '../lib/index.js'

const baseCfg = {
  maxDepth: 3,
  perTaskOutputChars: 4000,
  budgetChars: 150000,
  noticeMaxChars: 48000,
  promptSectionOrder: 110,
  defaultMaxConcurrency: 4,
  maxConcurrencyCap: 16,
  maxTasks: 64,
  backgroundDefault: true,
  defaultProvider: 'spawn',
  toolName: 'parallel_pool',
  taskTimeoutMs: 1_800_000,
  maxRetries: 1,
  retryDelayMs: 5_000,
  tasksPerWorker: 12,
}

function makeHarness(scenario) {
  const listeners = {}
  let workerSeq = 0
  const interrupts = []
  const followups = []
  const created = []
  const ctx = {
    subagents: {
      async startContinuable({ label, request }) {
        const childId = `worker-${++workerSeq}`
        created.push({ childId, label, prompt: request.prompt[0].text })
        scenario.onDispatch(childId, request.prompt[0].text)
        return { childId, messageId: `m-${childId}` }
      },
      async followup(_parent, childId, content) {
        followups.push({ childId, text: content[0].text })
        scenario.onDispatch(childId, content[0].text)
        return 'm-follow'
      },
      interrupt(id) { interrupts.push(id) },
    },
    get() { return undefined }, // sessionQuery 缺失 → 跳过失败详情富化
    on(_name, listener) {
      listeners['subagent/end'] = listener
      return () => { delete listeners['subagent/end'] }
    },
  }
  const harness = { ctx, listeners, interrupts, followups, created }
  scenario.harness = harness
  return harness
}

/** 模拟平台结算事件：直接调用引擎注册的 per-run 监听器。 */
function finish(harness, childId, stopReason, text) {
  const listener = harness.listeners['subagent/end']
  if (listener !== undefined) {
    listener({ id: childId, stopReason, lastAssistantMessage: text === undefined ? [] : [{ type: 'text', text }] })
  }
}

/** A：全部成功（每回合 30ms 后完成）。 */
const scenarioAllOk = () => ({
  onDispatch(childId, prompt) { setTimeout(() => finish(this.harness, childId, 'completed', `DONE:${prompt}`), 30) },
})
/** B：第 3 个回合失败（其余成功）。 */
const scenarioFailThird = () => {
  let count = 0
  return {
    onDispatch(childId, prompt) {
      count += 1
      const fail = count === 3
      setTimeout(() => finish(this.harness, childId, fail ? 'error' : 'completed', fail ? undefined : `DONE:${prompt}`), 30)
    },
  }
}
/** C：首个回合完成后立即中止。 */
const scenarioAbortAfterFirst = () => {
  let count = 0
  return {
    onDispatch(childId, prompt) {
      count += 1
      setTimeout(() => {
        finish(this.harness, childId, 'completed', `DONE:${prompt}`)
        if (count === 1) this.harness.controller.abort()
      }, 30)
    },
  }
}
/** D：全部挂起（无结算事件）——超时路径。 */
const scenarioHang = () => ({ onDispatch() { /* 永不结算 */ } })
/** E：首回合失败、重试回合成功。 */
const scenarioFailOnce = () => {
  let count = 0
  return {
    onDispatch(childId, prompt) {
      count += 1
      const fail = count === 1
      setTimeout(() => finish(this.harness, childId, fail ? 'error' : 'completed', fail ? undefined : `DONE:${prompt}`), 30)
    },
  }
}

const tasks = (n) => Array.from({ length: n }, (_, i) => ({ description: `task-${i + 1}`, prompt: `prompt-${i + 1}` }))

async function run(name, scenario, taskList, maxConcurrency, cfgOverrides = {}, failFast = false) {
  const harness = makeHarness(scenario)
  harness.controller = new AbortController()
  const cfg = { ...baseCfg, ...cfgOverrides }
  const summary = await runPool(harness.ctx, cfg, {
    tasks: taskList,
    maxConcurrency,
    provider: 'spawn',
    failFast,
    parent: { id: 'parent-session' },
    signal: harness.controller.signal,
  })
  console.log(`\n=== ${name} ===`)
  console.log('children:', harness.created.map((c) => c.childId).join(','))
  console.log('followups:', harness.followups.length, '| interrupts:', harness.interrupts.length)
  console.log('summary:', JSON.stringify({ total: summary.total, completed: summary.completed, failed: summary.failed, aborted: summary.aborted, skipped: summary.skipped, rollingRefill: summary.rollingRefill }))
  console.log('statuses:', summary.results.map((r) => `${r.description}:${r.status}${r.attempts ? `(x${r.attempts})` : ''}`).join(' | '))
  return { harness, summary }
}

console.log('\n=== 断言 ===')
const results = []
{
  const { harness, summary } = await run('A 全部成功 5×2', scenarioAllOk(), tasks(5), 2)
  results.push(['A: 5/5 completed', summary.completed === 5 && summary.total === 5])
  results.push(['A: 仅 2 个子代理', harness.created.length === 2])
  results.push(['A: 3 次 followup', harness.followups.length === 3])
  results.push(['A: rollingRefill', summary.rollingRefill === true])
  results.push(['A: 每任务输出正确', summary.results.every((r, i) => r.output === `DONE:prompt-${i + 1}`)])
}
{
  const { summary } = await run('B 失败+failFast 4×2', scenarioFailThird(), tasks(4), 2, { maxRetries: 0 }, true)
  results.push(['B: 失败任务计入 failed', summary.failed >= 1])
  results.push(['B: 无重试（maxRetries 0）', summary.results.every((r) => r.attempts === undefined)])
}
{
  const { summary } = await run('C 中止 2×1', scenarioAbortAfterFirst(), tasks(2), 1)
  results.push(['C: kill 前完成任务保留为 completed', summary.completed === 1 && summary.skipped === 1])
}
{
  const { harness, summary } = await run('D 挂死+超时+重试耗尽 1×1', scenarioHang(), tasks(1), 1, { taskTimeoutMs: 150, maxRetries: 1, retryDelayMs: 0 })
  results.push(['D: 超时任务记 failed', summary.failed === 1])
  results.push(['D: 重试 2 次尝试', summary.results[0].attempts === 2])
  results.push(['D: 每次尝试 interrupt', harness.interrupts.length === 2])
  results.push(['D: 每次尝试换新子代理', harness.created.length === 2])
  results.push(['D: 超时错误文案', String(summary.results[0].error).includes('timed out')])
}
{
  const { summary } = await run('E 失败后重试成功 1×1', scenarioFailOnce(), tasks(1), 1, { maxRetries: 1, retryDelayMs: 0 })
  results.push(['E: 重试后 completed', summary.completed === 1])
  results.push(['E: attempts=2', summary.results[0].attempts === 2])
}
{
  const { harness, summary } = await run('F worker 轮换 5×1', scenarioAllOk(), tasks(5), 1, { tasksPerWorker: 2 })
  results.push(['F: 5/5 completed', summary.completed === 5])
  results.push(['F: 轮换产生 3 个子代理', harness.created.length === 3])
}
{
  // G: 每 worker 1 任务 → 等价旧引擎每任务一子代理（轮换上限语义）
  const { harness, summary } = await run('G 每 worker 1 任务 4×2', scenarioAllOk(), tasks(4), 2, { tasksPerWorker: 1 })
  results.push(['G: 4/4 completed', summary.completed === 4])
  results.push(['G: 4 个子代理', harness.created.length === 4])
}

let allPass = true
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) allPass = false
}
console.log(allPass ? '\nALL PASS ✅' : '\nSOME FAIL ❌')
process.exit(allPass ? 0 : 1)
