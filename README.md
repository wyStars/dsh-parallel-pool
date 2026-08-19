# dsh-parallel-pool — 动态滚动窗口子代理任务池

解决主对话并发派发子代理时的**轮次屏障**问题：现有模式需要等"整轮"所有子代理
结束才开始下一轮，慢任务拖慢全批。本插件提供 `parallel_pool` 工具：一次调用
传入任务列表 + 并发上限，内部实现**滚动窗口调度**——任何子代理一结束立刻补位
下一个任务（不等整轮），全部结算后一次性返回每个任务的结果与起止时间线。

## 用法（模型可见工具）

```
parallel_pool {
  tasks: [{ prompt, description?, model? }, ...],   // ≤64 个独立任务
  maxConcurrency?: 2,                                // 默认 4，范围 1..16
  provider?: 'spawn' | 'fork',                       // 默认 'spawn'（全新子代理）
  failFast?: false,                                  // 首个失败后停止补位
}
```

返回：`total/completed/failed/aborted/skipped`、总耗时、峰值并发、
`rollingRefill`（是否发生了补位）以及每个任务的结果与 `startedAt/endedAt` 时间线。

## 设计

- 基于 `ctx.subagents.start(provider, { label, prompt, parent, signal })` 派生
  一次性子代理（对齐官方 `tool-subagent` 模式），`run.result` 结算、
  `run.dispose()` 释放。
- 结算回调中触发补位：`active < maxConcurrency` 且队列非空即派发。
- `exec.signal` 中止时停止补位并立即返回部分结果（未启动任务标记 `skipped`）。
- **失败详情富化（v0.0.2）**：子代理失败（如模型路由 402 余额不足）时，经
  `subagent/end` 事件定位子会话，回读 `turn/end` 底层错误并入结果 `error` 字段，
  避免外部故障被误判为插件问题。
- `signal` 始终显式提供（spawn 路径要求存在），缺失时用一次性独立控制器兜底。
- 所有注册挂 `ctx.effect`：卸载/热重载自动清理。

## 构建 / 注入 / 卸载（dsh-super-injector 通道）

```bash
bash scripts/build.sh   # junction 链接 @deepseek-ai/dsh-tools + node --check
```

或经注入器工具：`dev_build_plugin` → `dev_inject_plugin` →
`dev_reload_package dsh-parallel-pool`（热重载）→ `dev_uninject_plugin`（卸载）。
