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
  会话消息投递。`job_output`/`job_kill` 对该 id 可用；kill 时投递部分结果。
- **前台模式（background: false）**：等待整批完成，结果内联返回。
- 返回汇总：`total/completed/failed/aborted/skipped`、总耗时、峰值并发、
  `rollingRefill`（是否发生补位）、每任务结果与时间线。
- 系统提示引导：对 2+ 独立任务整批交给 parallel_pool，而不是手动逐波派发
  subagent（引导段 order 110，早于官方 tool-subagent 的 116.5）。

## 设计

- 基于 `ctx.subagents.start(provider, { label, prompt, parent, signal })` 派生
  一次性子代理（对齐官方 `tool-subagent` 模式），`run.result` 结算、
  `run.dispose()` 释放。
- 结算回调中触发补位：`active < maxConcurrency` 且队列非空即派发。
- **后台 job 无主注册**（对齐 dsh-shell-callback）：tool-jobs 监听器对无主
  job 直接 return，本插件 onJobDone 回调成为唯一通知者；`attachController`
  使无主 start 通过前置检查；回调经 `agent.followup`/`agent.inject` 投递。
- **失败详情富化（v0.0.2）**：子代理失败（如模型路由 402 余额不足）时，经
  `subagent/end` 事件定位子会话，回读 `turn/end` 底层错误并入结果 `error` 字段，
  避免外部故障被误判为插件问题。
- `signal` 始终显式提供（spawn 路径要求存在），缺失时用一次性独立控制器兜底。
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
