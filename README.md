# dsh-parallel-pool — 动态滚动窗口子代理任务池

把"整批独立任务"一次交给任务池，**主对话不阻塞**：后台运行时滚动窗口补位
（任何子代理一结束立刻派发下一任务，不等整轮），全批结算后完整结果与时间线
作为会话消息自动投递、唤醒主对话。

## 用法（模型可见工具）

```
parallel_pool {
  tasks: [{ prompt, description?, model? }, ...],   // ≤64 个独立任务
  maxConcurrency?: 2,                                // 默认 4，范围 1..16
  provider?: 'spawn' | 'fork',                       // 默认 'spawn'（全新子代理）
  failFast?: false,                                  // 首个失败后停止补位
  background?: true,                                 // 默认后台：返回 job id，结果消息投递
}
```

- **后台模式（默认）**：立即返回 `{kind:'background', jobId}`（毫秒级），池在
  后台滚动调度；全批结算后完整结果（含每任务 `startedAt/endedAt` 时间线）作为
  会话消息投递。**`job_output` 实时返回每任务进度与终态富文本（v0.3.0）**；
  `job_kill` 中止批任务并投递部分结果。
- **前台模式（background: false）**：等待整批完成，结果内联返回（仅建议
  小批量快速任务）。
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

## 构建 / 注入 / 卸载（dsh-super-injector 通道）

```bash
bash scripts/build.sh   # 依赖落地 + 语法/导入链校验
```

依赖落地策略（loader 内部解析器实测只认包根 index.js、不读 package.json）：
dsh-tools 走 junction；dsh-llm 及其传递闭包（cordis/cosmokit/schemastery/
dsh-timeout）复制为真实目录副本并生成包根 index.js 再导出垫片。

注入器工具：`dev_build_plugin` → `dev_inject_plugin` →
`dev_uninject_plugin`（卸载）。
