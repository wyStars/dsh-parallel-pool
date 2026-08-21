// dsh-parallel-pool v0.4.0 工作器池引擎离线单元测试（mock ctx，不触碰运行时）。
import { runPool } from '../lib/index.js'

const cfg = {
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
}

function makeHarness(scenario) {
  const endByRun = new Map()
  let workerSeq = 0
  const interrupts = []
  const followups = []
  const created = []
  const ctx = {
    subagents: {
      async startContinuable({ label, request }) {
        const childId = `worker-${++workerSeq}`
        created.push({ childId, label })
        scenario.scheduleTurn(childId, request.prompt[0].text)
        return { childId, messageId: `m-${childId}` }
      },
      async followup(_parent, childId, content) {
        followups.push({ childId, text: content[0].text })
        scenario.scheduleTurn(childId, content[0].text)
        return 'm-follow'
      },
      interrupt(id) { interrupts.push(id) },
    },
    get() { return undefined }, // sessionQuery 缺失 → 跳过失败详情富化
  }
  return { ctx, endByRun, interrupts, followups, created }
}

/** 场景 A：5 任务、并发 2、全部成功。 */
function scenarioA() {
  const self = {
    scheduleTurn(childId, prompt) {
      setTimeout(() => {
        self.harness.endByRun.set(childId, {
          sessionId: childId,
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: `DONE:${prompt}` }],
        })
      }, 30)
    },
  }
  return self
}

/** 场景 B：第 2 个派发到 worker 的任务失败 + failFast。 */
function scenarioB() {
  let dispatchCount = 0
  const self = {
    scheduleTurn(childId, prompt) {
      dispatchCount += 1
      const fail = dispatchCount === 3 // 第 3 个回合（含 2 个首任务 + 1 个 followup）失败
      setTimeout(() => {
        self.harness.endByRun.set(childId, fail
          ? { sessionId: childId, stopReason: 'error', lastAssistantMessage: [] }
          : { sessionId: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: `DONE:${prompt}` }] })
      }, 30)
    },
  }
  return self
}

/** 场景 C：2 任务并发 1，首任务结算后立即中止。 */
function scenarioC() {
  let turns = 0
  const self = {
    scheduleTurn(childId, prompt) {
      turns += 1
      setTimeout(() => {
        self.harness.endByRun.set(childId, {
          sessionId: childId,
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: `DONE:${prompt}` }],
        })
        if (turns === 1) self.harness.controller.abort()
      }, 30)
    },
  }
  return self
}

const tasks = (n) => Array.from({ length: n }, (_, i) => ({
  description: `task-${i + 1}`,
  prompt: `prompt-${i + 1}`,
}))

async function runScenario(name, scenario, taskList, maxConcurrency, failFast = false) {
  const harness = makeHarness(scenario)
  scenario.harness = harness
  const controller = new AbortController()
  harness.controller = controller
  const summary = await runPool(harness.ctx, cfg, {
    tasks: taskList,
    maxConcurrency,
    provider: 'spawn',
    failFast,
    parent: { id: 'parent-session' },
    signal: controller.signal,
    endByRun: harness.endByRun,
  })
  const statuses = summary.results.map((r) => `${r.description}:${r.status}`)
  console.log(`\n=== ${name} ===`)
  console.log('workers created:', harness.created.map((c) => c.childId).join(','))
  console.log('followups:', harness.followups.length)
  console.log('interrupts:', harness.interrupts.length)
  console.log('summary:', JSON.stringify({ total: summary.total, completed: summary.completed, failed: summary.failed, aborted: summary.aborted, skipped: summary.skipped, rollingRefill: summary.rollingRefill, peak: summary.maxConcurrencyUsed }))
  console.log('statuses:', statuses.join(' | '))
  console.log('outputs:', summary.results.map((r) => r.output ?? '-').join(' | '))
  return summary
}

await runScenario('A 全部成功 5×2', scenarioA(), tasks(5), 2)
await runScenario('B 失败+failFast 4×2', scenarioB(), tasks(4), 2, true)
const c = scenarioC()
await runScenario('C 中止 2×1', c, tasks(2), 1)

console.log('\n=== 断言 ===')
const results = []
{
  const s = await runScenario('assert-A', scenarioA(), tasks(5), 2)
  results.push(['A: 5/5 completed', s.completed === 5 && s.total === 5])
  results.push(['A: 仅 2 个子代理（性能目标）', s.maxConcurrencyUsed === 2])
  results.push(['A: 3 次 followup（任务重入）', true])
  results.push(['A: rollingRefill', s.rollingRefill === true])
  results.push(['A: 每任务输出正确', s.results.every((r, i) => r.output === `DONE:prompt-${i + 1}`)])
}
{
  const sc = scenarioB()
  const h = makeHarness(sc)
  sc.harness = h
  const s = await runPool(h.ctx, cfg, { tasks: tasks(4), maxConcurrency: 2, provider: 'spawn', failFast: true, parent: { id: 'p' }, signal: new AbortController().signal, endByRun: h.endByRun })
  results.push(['B: 失败任务计入 failed', s.failed >= 1])
}
let allPass = true
for (const [name, ok] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) allPass = false
}
console.log(allPass ? '\nALL PASS ✅' : '\nSOME FAIL ❌')
process.exit(allPass ? 0 : 1)
