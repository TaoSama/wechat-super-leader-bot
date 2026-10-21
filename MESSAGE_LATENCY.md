# 微信消息延迟分析

Gateway 与 Controller 自动向标准错误日志通道写入 `event=message_latency` 的 JSON 日志，Docker logs 会收集这些记录，无需开启调试或修改数据库。CLI 标准输出保留原来的 JSON 结果格式。现有 Docker 日志按每个容器 10 MB × 3 轮转，排查时应及时采集。

## 采集与分析

在生产主机的仓库目录运行（容器名以实际部署为准）：

```sh
docker logs --since 1h --timestamps super-leader-gateway > /tmp/message-latency.log 2>&1
docker logs --since 1h --timestamps super-leader-controller-1 >> /tmp/message-latency.log 2>&1
node scripts/analyze-message-latency.mjs --input /tmp/message-latency.log
node scripts/analyze-message-latency.mjs --input /tmp/message-latency.log --json --limit 50
node scripts/analyze-message-latency.mjs --input /tmp/message-latency.log --trace-id <traceId> --json
```

也可以把两服务日志依次写到标准输入。合并日志无需预排序；同一个进程内部事件仍应保留原顺序。输出按最后观测时间倒序，空轮询不会占用消息名额。原始日志可能混有应用普通日志，请按现有生产日志的访问要求保管，排查完成后删除临时采集文件。

`traceId` 是聊天与消息 ID 元组的 SHA-256，同一条消息重试时保持一致；`attemptId` 区分每次处理或恢复。Controller 的 `parentAttemptId` 对应 Gateway 的一次调用链，分析器据此关联，未匹配记录单独保留，避免串入其他重试。每条记录包含服务、进程实例、UTC 时间及进程内单调时钟耗时。

## 观测范围

| 环节 | 主要记录 |
| --- | --- |
| 微信收取 | 长轮询 HTTP、平台消息时间、接收时间、批次位置与数量 |
| 批内等待 | 一批消息先统一记录接收，逐条开始时记录 `batchWaitMs` |
| Gateway | 授权、上下文落盘、Leader 调用、outbox 落盘、恢复读取与交付 |
| Codex | 聊天锁、工作区/记忆/journal、MCP 启停及工具调用、SDK 首事件/首条 agent message、item 生命周期、turn usage、流排空 |
| Controller | 请求去重、Leader/model/tool、模型 HTTP 请求头/正文/解析、各次重试及退避、结果落盘、响应结束或断开 |
| 微信发送 | 文本渲染与分片、发送锁、发送意图落盘、每片 HTTP 和回执校验、回执落盘、最终交付状态 |

日志字段使用白名单，不记录消息正文、prompt、工具参数/输出、请求 URL、token 或错误原文。模型 token 用量是计数，不是凭据。埋点失败不会改变业务结果；它不新增发送重试，也不改变结果不明时的防重隔离。

## 如何判断优化方向

先看 `platformToReceivedMs`、`batchWaitMs`、`leaderMs` 与 `deliveryMs`，定位长轮询前后、批内等待、推理或发送占比；再展开对应 `stages`。模型侧对比 HTTP 请求头/正文和工具耗时，原生 Codex 侧看锁等待、SDK item wall time 和流排空。多条连发先检查批次与等待，不要把等待误判为模型耗时。

同一条消息可能有多次处理、HTTP 重试或仅恢复交付。分析器保留所有独立尝试与阶段耗时数组；一次早期分片成功不代表整条回复发送成功。阶段可能嵌套或重叠，**不能直接相加为端到端耗时**。

平台时间与服务端存在时钟偏差时，端到端平台耗时显示 `unknown`；不同机器的 UTC 时间差也不能替代同进程单调时钟。SDK 首事件和首条 agent message **不是模型 TTFT**。当前 SDK 不提供可靠的原生 turn ID、真实 TTFT 或精确 CLI 退出时刻；`turn.completed` 到流排空也不等于纯 CLI 退出耗时。微信 API 接受仅证明接口受理，手机收到、通知弹出和已读时间仍不可观测。

## 微信会话目录

微信列表按 Project 的完整工作目录和机器分组，Project 名后显示机器；组与组内按会话 `updatedAt` 最近更新倒序，未知时间排最后。会话前显示真实执行状态，原标题完整保留，未观测到的状态显示未知。未关联工作目录时明确显示“未关联 Project”。默认返回全部已观测会话；真正超过消息预算时保留完整条目并说明未展示数量。此规则不改变 Dashboard。
