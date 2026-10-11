# 已有终端 Agent 观测接入

## 目标与边界

在同一个宿主 Daemon 内接入明确配置的既有终端 Agent，供微信自然语言查询与 Web 状态列表使用。当前阶段只增加状态与用户显式请求的终端快照读取；不新建终端、不启动 Agent、不发送输入，不以此代替最终的 CLI 控制能力。

当前实际协议依赖为 Herdr 0.9.0，其随程序提供的静态 API schema 使用 protocol 22；不是任意 CLI 或任意 Unix socket 的通用附着协议。本轮只读取版本、帮助和静态 schema，未读取或控制 Mini 的焦点会话。用户需指定可验收的命名会话/终端；不能从焦点推断目标。

## 静态协议契约

传输为已有本机 Unix socket 上的单行 JSON；每次请求使用新 ID，响应必须精确关联，且 result/error 二选一。仅允许 `ping`、`agent.get`、`pane.read` 三种只读方法，协议必须精确匹配 22。方法名不接受外部输入。不自动启动服务，也不使用 CLI 子进程作为后备。

- `ping` 参数 `{}`；结果 `type=pong`，含整数 `protocol` 与字符串 `version`。
- `agent.get` 参数 `{target: <明确 pane_id>}`；结果 `type=agent_info`、`agent` 对象。必要身份为 `pane_id`、`terminal_id`、`workspace_id`、`tab_id`；状态为 `agent_status`，取值 idle/working/blocked/done/unknown。`agent` 是提供方名。`revision` 为 uint64。可选的 `agent_session` 含 source/agent/kind/value，其中 kind 为 id 或 path；这些字段只用于绑定身份，绝不作为文件读取路径。
- `pane.read` 参数 `{pane_id, source:"recent_unwrapped", format:"text", strip_ansi:true, lines:120}`；结果 `type=pane_read`、`read` 对象，含 pane_id/workspace_id/tab_id/source/format/text/revision/truncated。它是有限终端屏幕快照，不是完整对话历史。CLI 的 `recent-unwrapped` 拼写不能直接作为 wire enum。
- `agent.prompt` 的静态结果仅为 `type=agent_prompted` 与 AgentInfo；没有原生 turn ID。当前阶段不得调用它，也不得根据 idle/done 伪造命令 completed。

## 配置与身份

新增显式 `--terminal-sock` 和可重复的 `--terminal-pane`，必须成对配置；socket 必须是绝对路径，pane 必须使用明确的 wN:pN ID，禁止使用焦点、名称猜测、空目标。限制最多 16 个，拒绝重复。默认不启用。原生用户服务保存相同参数，macOS/Linux 行为相同，不更改终端宿主配置。

公有会话 ID 使用 `terminal:` 前缀与 `[socket,pane,terminal,workspace,tab,provider,agent_session]` JSON 元组绑定的 SHA256；完整 256bit 摘要使用无填充 base64url（43 字符）编码，总长 52 字符，符合现有持久层 64 字符限制，不截断哈希。不暴露 socket 或 transcript 路径，不与 Codex thread ID 合并。pane 迁移、进程/Agent 身份更换后，旧 ID 不可读到新目标。前后两次 agent.get 必须确认同一绑定，pane.read 的身份和 revision 必须在该区间内；不能用标题、最新输出或模糊名称猜测归属。

提供方表示为 `terminal/<agent>`。会话仅有 read 能力，loaded 不作为终端发送依据；模型缺少可信字段时留空，不从标题或全局配置推断。working 映射 active，idle/done 映射 idle，blocked 保留 blocked，未知保持 unknown；这些均是宿主生命周期观测，不是具体任务完成回执。

## Daemon 与展示

终端观测具有独立、单飞且有界的刷新任务，不阻塞原 Codex 发现、桌面观测和心跳。配置缺省时行为不变；终端源单独失效时仅撤销自己的新鲜状态，原来源不受影响。读取失败保留必要元数据并显示 unknown，不以新的 observedAt 刷新旧的运行状态。

节点注册和重连不等待任何首次终端发现；hello 发送已有缓存（初次可能没有终端），随后通过状态更新补齐。先恢复连接、命令回执与心跳，再独立发现终端，避免故障终端拖慢其他会话上线。终端每 15 秒刷新，来源有效期 45 秒；运行中读取整体 10 秒、单 RPC 3 秒有界。进程退出和连接中断后取消并等待自有观测 worker 收尾。

`--probe` 报告独立 terminal 来源，即使控制 socket 不可用也能说明终端观测是否可用；不读取节点 token，不打开命令 journal，不连接 Controller。微信 read_session 沿用既有读命令，明确返回“终端快照”，裁剪与失败必须可见。Web 显示只读边界；不能把终端文本塞进带伪造 turn ID 的对话历史。所有向 terminal: ID 的 send 与 inspect_turn 在本机拒绝，不能回退 Codex socket 或桌面 owner。

## 验收契约

使用临时 Unix socket 构造 protocol 22 服务，覆盖错响应 ID、协议/目标错配、忙碌/审批/未知状态、进程替换、读取前后身份变化、revision 乱序、坏帧/超限/超时/取消和默认关闭。断言网络仅出现三种只读方法，绝无 prompt/start/resume/send。跨 Controller/Daemon 的合成验证须证明状态可见、read 的快照标签与拒绝写入，而不是仅编译通过。

真实 Mini 会话读取和最终 CLI 发送仍未验收；未指定目标前不读取默认/焦点会话。固定依赖计划仅认精确完成的既有规则不变，后续发送必须单独设计投递证据，不能因这个观测接入放宽授权或完成门槛。
