# dsh-parallel-pool — 动态滚动窗口子代理任务池

把"整批独立任务"一次交给任务池，**主对话始终不阻塞**：提交后立即返回 job id，
后台滚动窗口补位（任何子代理一结束立刻派发下一任务，不等整轮）；每个子任务
结算时立即把该任务结果投递给主对话，整批结束后再投递完整汇总与时间线。

## 用法（模型可见工具）

```
parallel_pool {
  tasks: [{ prompt, description?, model? }, ...],   // ≤64 个独立任务
  maxConcurrency?: 2,                                // 默认 4，范围 1..16
  provider?: 'spawn' | 'fork',                       // 默认 'spawn'（全新子代理）
  failFast?: false,                                  // 首个失败后停止补位
  background?: true,                                 // 兼容参数；始终非阻塞，返回 job id 并增量推送
}
```

- **始终非阻塞**：无论 `background` 是否为 false，都立即返回
  `{kind:'background', jobId}`（毫秒级），池在后台滚动调度；**每个子任务结算
  时立即向主对话投递该任务结果**，主对话无需等待整批结束即可及时处理。
  **`job_output` 实时返回每任务进度与终态富文本（v0.3.0）**；`job_kill`
  中止批任务并投递部分结果。
- 整批结束后仍会投递完整汇总（含每任务 `startedAt/endedAt` 时间线）。
- 返回汇总：`total/completed/failed/aborted/skipped`、总耗时、峰值并发、
  `rollingRefill`（是否发生补位）、每任务结果与时间线。
- 系统提示引导：对 2+ 独立任务整批交给 parallel_pool，而不是手动逐波派发
  subagent（引导段 order 110，早于官方 tool-subagent 的 116.5）。
- **宽松校验（v0.3.0）**：`model`/`description` 为空字符串视为未提供。

## 设计

- **工作器池（v0.4.0，性能优化）**：持久子代理数 = 并发数而非任务数——
  每个 worker 串行处理任务（首任务随 `startContinuable` 创建派发，后续经
  `subagents.followup`），每任务一回合、`subagent/end` 逐回合结算。
  Web 会话回显与子代理目录的加载负载不再随任务数增长（实测：189 个子代理
  → `listChildren` 13.6s，每冷子代理折叠 ~68ms；64 任务批次旧引擎产生 64 个
  子会话，新引擎仅 maxConcurrency 个）。
- **健壮性（v0.5.0）**：
  - `taskTimeoutMs`（默认 30min，0=不限）：单任务超时 → interrupt 子代理 +
    记 failed，防 worker 挂死导致整批永不结算；
  - `maxRetries`（默认 1，0..3）：失败自动重试（换新子代理执行，
    `retryDelayMs` 默认 5s），覆盖瞬态故障（配额抖动/网络）；
  - `tasksPerWorker`（默认 12）：每 worker 处理任务数上限，到点退役换新，
    防长批下上下文累积污染；
  - per-run 事件监听：只登记本池在途子代理的结算事件，随 run 注销零噪音。
- **job readOutput（v0.3.0）**：每任务结算即更新进度文本（`N/M settled` +
  逐行结果），`job_output` 实时可见；终态输出完整汇总——模型自行轮询也能
  拿到富文本结果，不再只有裸状态串。
- **后台 job 无主注册**（对齐 dsh-shell-callback）：tool-jobs 监听器对无主
  job 直接 return，本插件 onJobDone 回调成为唯一通知者；`attachController`
  使无主 start 通过前置检查；回调经 `agent.followup`/`agent.inject` 投递。
- **失败详情富化（v0.0.2）**：子代理失败（如模型路由 402 余额不足）时，经
  `subagent/end` 事件定位子会话，回读 `turn/end` 底层错误并入结果 `error` 字段，
  避免外部故障被误判为插件问题。
- 中止时停止派发并逐个 `interrupt` in-flight 子代理（1s 宽限期等待 worker
  记录已结算结果），未启动任务标记 `skipped`。
- 所有注册挂 `ctx.effect`：卸载/热重载自动清理。

## 安装（npm / dsh plugin）

```bash
dsh plugin --profile web add @stars-w/dsh-parallel-pool
```

包已发布到 npm（public），安装后会自动追加到 profile 的
`dsh.profile.bundles`，作为标准 bundle 加载。

## Web 插件配置

在 Web 插件配置页中可设置默认并发数：

- `maxConcurrency`：默认 4，范围 1..16。

修改后下一次调用 `parallel_pool` 即生效；单次调用仍可用参数 `maxConcurrency`
临时覆盖该默认值。

## 本地开发 / 构建 / 注入

```bash
bash scripts/build.sh   # 依赖落地 + 语法/导入链校验
```

依赖落地策略（loader 内部解析器实测只认包根 index.js、不读 package.json）：
dsh-tools 走 junction；dsh-llm 及其传递闭包（cordis/cosmokit/schemastery/
dsh-timeout）复制为真实目录副本并生成包根 index.js 再导出垫片。

本地注入器工具：`dev_build_plugin` → `dev_inject_plugin` →
`dev_uninject_plugin`（卸载）。
