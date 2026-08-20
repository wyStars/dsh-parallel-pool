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

- 基于 `ctx.subagents.startContinuable({provider, label, request, signal})` 派生
  **continuable 子代理（v0.2.0，对齐默认 subagent 工具）**：子代理面板实时
  可见（running 徽标）、完成后保留为可续跑子代理、平台原生完成通知；
  `subagent/end` 事件结算 `{stopReason, lastAssistantMessage}`。
- 结算回调中触发补位：`active < maxConcurrency` 且队列非空即派发。
- **job readOutput（v0.3.0）**：每任务结算即更新进度文本（`N/M settled` +
  逐行结果），`job_output` 实时可见；终态输出完整汇总——模型自行轮询也能
  拿到富文本结果，不再只有裸状态串。
- **后台 job 无主注册**（对齐 dsh-shell-callback）：tool-jobs 监听器对无主
  job 直接 return，本插件 onJobDone 回调成为唯一通知者；`attachController`
  使无主 start 通过前置检查；回调经 `agent.followup`/`agent.inject` 投递。
- **失败详情富化（v0.0.2）**：子代理失败（如模型路由 402 余额不足）时，经
  `subagent/end` 事件定位子会话，回读 `turn/end` 底层错误并入结果 `error` 字段，
  避免外部故障被误判为插件问题。
- 中止时停止补位并逐个 `interrupt` in-flight 子代理，未启动任务标记 `skipped`。
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
