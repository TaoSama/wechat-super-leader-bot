# 原客户端会话路由研究

核对日期：2026-10-11。本文区分已观察事实、静态协议与尚未实施的设计。Daemon 原 owner 发送已完成一次真实验收，Controller/Leader/Web 路由资格随后已接入本地源码并通过跨层 fixture 验证；尚未部署，见 [路由接线验收](../2026-10-11-desktop-send-route/VERIFICATION.md)。

2026-10-12 增量：原桌面已记录历史现已在本地实现独立 reader、来源固定和分页 context。下文“研究当时未实现”保留为当时事实；当前边界、真实读取与跨层验证以 [历史设计](../2026-10-12-desktop-history/TECH.md) 和 [验收记录](../2026-10-12-desktop-history/VERIFICATION.md) 为准，运行服务仍未更新。

同日后续已统一 observer/control/history 的桌面入站为 32 MiB，原生出站仍为 16 MiB，并限制控制连接与结构展开。下文初版 observer 16 MiB 不再代表当前本地实现，见 [大快照边界](../2026-10-12-desktop-frame-budget/TECH.md)。

## 结论与边界

当前桌面应用内部存在 owner/follower 路由。只读连接已发现本任务的 owner 并成功读取模型设置；归档测试目标返回 `no-client-found`。此前对若干目标的失败不代表所有会话都没有 owner。控制 socket 的 `notLoaded` 仍不能伪装为 loaded，不能通过恢复会话抢占其他 writer。

共享控制 socket 不可用，不等于桌面原会话没有控制路由。因此不能把更换 App transport、启动共享 app-server 或重启桌面应用当成接入前置条件。现有 owner 路由可以独立核查；没有发现精确目标的 owner 时仍只读，不能将其他目标的成功外推到该目标。

这不是已公开的稳定 API。实际安装为 `/Applications/ChatGPT.app`，版本 `26.1007.30912`、build `20156`。研究只读取应用资源，没有解包写文件、注入应用 JS 或修改配置。

[官方 Turns 文档](https://learn.chatgpt.com/docs/app-server#turns) 确认 `turn/start` 返回精确 `turn.id`，但没有给出“仅在空闲时原子受理”的契约。当前客户端发送实现也未显示这一保证。现有实现仅提供有界预检，不宣称已经解决用户同时在 App 发送时的竞争；此限制不能反向解释为必须更改 App transport。

## 实测只读协议

连接既有 `~/.codex/ipc/ipc.sock`，每帧为 4 字节小端无符号长度及 UTF-8 JSON。客户端必须自行设置更小的帧长、超时与并发上限，不能直接采用服务端 256 MiB 上限。

1. `initialize`：`type=request`、新 UUID `requestId`、`sourceClientId=initializing-client`、`version=0`、`params.clientType=super-leader-readonly-diagnostic`。成功后使用 `result.clientId` 作为该连接的 sourceClientId。
2. `thread-owner-discovery`：version 1，params 为 `{hostId:"local",conversationId:<精确ID>}`。成功的 `handledByClientId` 是 owner，不能用 sourceClientId 代替。
3. `thread-follower-read-model-settings`：version 1，params 为 `{conversationId:<同一ID>}`，`targetClientId` 固定为发现的 owner。本地 follower 信封省略 hostId；当前实现显式 hostId 会改变协议版本。
4. 核对 response requestId、method、resultType、handledByClientId；读取完关闭连接。未知、错目标、旧连接响应必须拒绝。

只读结果：

| 精确目标 | 结果 |
| --- | --- |
| 主任务 `b3b881ff-1039-58a6-b55f-d74a65602646` | discovery 成功；模型设置为 gpt-6-astra / ultra / openai_http、resumeState=resumed、threadSource=user |
| 已归档 fixture `3626524b-307b-56f4-a09a-3e34f2bc494d` | discovery 为 no-client-found，未继续请求 |

`no-client-found` 还可能包含版本不符、无 handler、host 不符、超时或断连，不能仅由该字符串诊断确切根因。所有诊断连接正常关闭、进程退出 0；未创建、恢复、发送或更改任何会话。

## 发送协议与单次实测

只读运行状态订阅已另行实现，详见下节和 [验收记录](../2026-10-11-desktop-observation/VERIFICATION.md)。发送适配器已在宿主 Daemon 接通并通过专用 fixture 实测，详见 [原 owner 发送验收](../2026-10-11-desktop-owner-send/VERIFICATION.md)；线上 Controller 尚不产生该路由的命令。

方法 `thread-follower-start-turn`，本地 version 2，固定 targetClientId，params：

```json
{
  "conversationId": "精确线程 ID",
  "turnStart": {
    "request": {
      "threadId": "相同线程 ID",
      "clientUserMessageId": "持久化请求 UUID",
      "input": [{"type": "text", "text": "消息正文", "text_elements": []}]
    },
    "context": {"inheritThreadSettings": true, "useUserMessageAdmission": false}
  }
}
```

owner handler 首先核对归属，调用 startTurn，底层通常调用 `turn/start`。成功 turn ID 位于 IPC `response.result.result.turn.id`，不是外层 requestId。不能将仅有 success、已入队或 UI 收到消息当作 accepted。

admission 路径会调用 `turn/addUserMessage`，其结果可能是 started、steered 或 duplicate；它不是“仅空闲发送”的替代。普通路径的未确认提交保护只检查 unconfirmedTurnSubmissions。未找到 `reject_if_busy`、`rejectIfBusy` 或 `busyStrategy` 字段；字符串缺席不是 backend 行为的完整证明。现有控制 socket 的 preflight 同样是非原子检查，不能声称它消除了 App 用户并发。

再次核对当前归档发现：`useUserMessageAdmission:false` 并不对所有线程强制禁用 admission。`AA` 先检查 `kA`；后者对满足 host 条件、durable 模式、aeon 来源或启动类型、带 clientUserMessageId 的非空纯文本请求直接返回 true。只有核实线程种类后才能解释这个 context 字段，不能把它当成通用的“不 steer”保证。`wj` 的 threadId 校验及 `y_` 的未确认提交检查仍然不构成原子 idle/approval 门禁。

IPC 错误仅保留字符串，底层 delivery.stage/requestId 不完整。写入后超时、断连、回执缺少合法 ID 必须 uncertain；不得通过再发一次、按最新 turn 或按相同文本猜测来恢复。

## 运行时接入边界

宿主机 Daemon 应按实际会话宿主选择适配器，不要求所有会话改用一个新后端：

- 桌面会话：对精确会话发现 owner，经当前版本的本机 IPC 路由请求；不隐式 resume，不更改桌面 transport。它是内部协议，需要版本核验和失效降级。
- 终端会话：接入已经承载目标进程的终端宿主控制接口，读取 pane 状态、向同一个 pane 提交输入。没有已验证控制接口的普通终端只读，不把“能读 transcript”描述为“能附着进程”。
- SDK 托管：新建后端再按历史 ID 恢复属于另一种运行方式，不能作为原桌面或原终端发送失败后的自动兜底。

终端的“输入已投递”回执不等于原生 turn 已完成；必须保留路由自己的回执语义。Controller 继续统一编排、持久化命令和展示状态，但不能为没有原生 turn ID 的路由伪造 turn ID 或 completed。macOS LaunchAgent / Linux 用户 systemd 只负责 Daemon 生命周期，不因此取得或更改其他应用的会话所有权。

本节是接入设计的核验结论，不表示已实现终端适配器。桌面发送已有专用 fixture 证明精确目标、单次投递、原客户端历史可见性和真实回执，但不代表 Web、微信或其他机器均已接通。

Daemon 只在显式配置 `--desktop-send`、命令指定 `sendRoute=desktop-owner` 且有持久 journal 时使用此路由：先原子保存 command claim 与两个 UUID，再在同连接发现 owner、校验 settings/snapshot、持久绑定 owner/connection/endpoint，最后再次预检并尝试一次写入。写后失联或无合法 turn ID 一律 uncertain；不重发、不改用控制 socket、不隐式恢复线程。ACK 可以清除回执正文，但必须保留原生 turn ID、路由身份和 replay guard。停用开关后，已受理命令的精确 turn 只读核查仍保留。

实测 settings/snapshot 的 `threadSource` 可为显式 null。当前客户端 `ee` 将它默认解释为 user；实现仅接受明确的 user 或显式 null，缺失字段、未知值、aeon/durable 仍拒绝。canonical 历史的 `islands[].entries[].value` 引用 `entitiesByKey`；精确 turn 的正文来自 `items[].type=agentMessage` 的 `text`，不是最新消息猜测。

同 owner 重复 `following:true` 会发布当前 snapshot，真实只读探测收到两次 revision=1 的 snapshot。但广播没有与请求关联的 nonce，不能证明收到的首个 snapshot 就是此次预检的新快照；revision 不倒退也不构成 freshness 或原子受理保证。此限制和客户端私有协议版本依赖必须保留。

## 后续接入约束

- Controller 仍是唯一编排权威；新连接位于宿主机 Daemon，保留原生读历史和精确 turn 核查，不新建隔离 worker 或另起 app-server。
- 分开表达真实 loaded 与 owner 可达性。只有满足经验证的发送前置条件才公开 send；离线、审批中、忙碌或未知一律只读。
- dispatch 接受 commandId/sessionId/prompt/expiresAt，回执关联精确 sessionId/turnId 和 owner 连接代次。先持久 claim，再发一次；沿用原 journal、scope 和 state-dir。
- 首次绑定 turnId 必须 accepted，之后才 completed/failed。同步完成也按此顺序。无 ID 的受理不是可跟踪命令。
- 只有底层提供按原 requestId 的可靠只读收据查询时才能恢复丢失 ID；clientUserMessageId 不是已经验证的幂等保证。
- 需要 fixture 验证 busy/审批竞争、owner 换代、断连各阶段、重复请求、精确目标及原 App 可见性。没有原子受理保证时不能声称非干扰发送。
- 实测优先复用 `c0863a5b-311c-5ab9-997b-be2e24fffb18`。仅在确需测试时显式恢复；最后确认具体 turn 结束再归档、退出测试登录并关闭临时连接。writer 冲突时不不断新建。主任务禁止用于发送验收。

## 可复核实现依据

来源 `/Applications/ChatGPT.app/Contents/Resources/app.asar`，header SHA256：`0ba43368dc2f01fcf2a29c8e02f30cc6bb879ce268c8672734504f791526ce50`。以下为该版本归档内文件的 UTF-8 字节偏移，升级后必须重新核对：

| 归档内文件 | 字节偏移 / 锚点 |
| --- | --- |
| `.vite/build/application-network-startup-CfAQmSYg.js` | 275950 / zc reader；277216 / Vc writer |
| `.vite/build/src-BJv5Mk7n.js` | 7809 / 版本表；8850 / host 版本规则 |
| 同上 | 525043 / bb owner handler；527871 / follower start-turn |
| 同上 | 1515 / ee 普通用户线程判定；301932 / em aeon 判定；810896 / kA 强制 admission；811130 / AA admission |
| 同上 | 407797 / y_ 未确认提交检查；841837 / wj；847679 / turn/start 选择 |
| 同上 | 849867 / accepted(H.turn.id)；852032 / return H |
| 同上 | 1524845 / router；1525413 / findClient；1540544 / owner 注册；1541702 / v1 response 解包 |
| `.vite/build/main-CqEoQDOU.js` | 723758 / bind exact host/owner；3342027 / renderer owner 注册条件 |

主 Agent 使用 Node fs 在内存中读取同一归档，独立确认 bb 包装、wj 底层调用及返回值、y_ 未确认提交保护；没有执行归档中的 JavaScript。下述独立只读观察器不提高发送能力；发送由上节的独立路由实现。

## 已实现的只读运行状态订阅

初始化采用 `clientType=super-leader-readonly-observer`，严格核对 `handledByClientId == result.clientId`。一个连接内最多 32 个未完成 owner discovery，逐项 5 秒截止；无 owner 的 error response 没有 method 字段，不能因此误判协议不符。请求超时只使对应目标不可用，迟到响应按精确 requestId 丢弃。单独读协程持续读取完整帧，不在半帧处按单请求超时重置 reader。

发现精确 owner 后发送广播（无请求 ack）：

```json
{"type":"broadcast","method":"thread-stream-following-changed","version":1,"sourceClientId":"本连接clientId","targetClientIds":["精确owner"],"params":{"conversationId":"目标ID","hostId":"local","following":true}}
```

接收 `thread-stream-state-changed` version 11，核对 source owner、目标收件人包含本 client、hostId 与 conversationId。`params.change` 的 snapshot 带 revision 与 conversationState；核对 state.id/hostId，初版只投影 `threadRuntimeStatus.type`，现增加下节的有界模型白名单。patches 带 baseRevision/revision/patches；严格核对 base 等于已应用 revision 且新 revision 递增，不要求无依据的 +1。Immer 路径是字符串/数字数组，支持 add/replace/remove；无关历史 patch 只推进 revision，不保存正文。未知类型降为 unknown，错误身份、坏 patch 或 revision gap 停止发布。

初始主任务快照实测为 9,318,795 bytes，后续 revision 2→3 的真实增量为 785 bytes。观察器限制每帧 16 MiB，持久缓存只保存状态和模型的有界投影；每个窗口 30 秒后退订并重连取得新快照，不每 2 秒读取完整历史。following:false 或断连移除 follower；订阅可能阻止原 owner 的空闲自动卸载，但不创建或恢复会话，也不获得 writer。

补充源码锚点（同一 app.asar）：main-CqEoQDOU.js byte 720131 订阅协议、744730 owner coordination；src-BJv5Mk7n.js byte 353815 follower 注册、355014 snapshot、351784 baseRevision 校验、594496 runtimeStatus 更新；conversation-turn-mutations-szl89rld.js byte 10080/10755/13472 为 Immer patch 实现。

## 历史与模型补充核验

2026-10-11 再次只读检查同一归档，header SHA256 未变。现有 `client.ReadHistory` 仍只使用控制 socket 的 `HistoryReader`，`DesktopController.InspectTurn` 仅查询精确 turn 回执，不提供面向 Web 的完整历史分页。研究当时 observer 尚未输出模型字段；2026-10-12 模型投影已接入本地源码并独立验收，历史读取仍未接入，不能将此前原 owner 发送验收描述为完整历史能力已经完成。

### 历史读取的真实边界

当前 follower 方法版本表与 owner handler 中发现 `thread-follower-load-complete-history`，本地 version 1，params 为 `{conversationId:<精确ID>}`，固定 `targetClientId`。响应只有 `{revision}`，正文通过原 stream snapshot/patch 广播传输，不是带 `data/nextCursor` 的分页响应。没有在该版本的 follower 注册表中发现单页历史方法；底层存在 `thread/turns/list`、`thread/items/list`，不代表外部 follower 可以直接调用它们。

owner 的 `getCompleteConversationTurns` 对普通会话要求 `resumeState=resumed`，随后在历史不完整时调用 `loadRemainingConversationTurns`；这个 owner 函数本身没有恢复会话。外围 UI 的历史辅助流程却带有不可用 owner 时恢复会话的逻辑，因此不能整体复制该流程作为只读适配器。未知或未加载的 owner 必须返回不可用，不能隐式恢复。

`turnHistory` 的 canonical islands 引用 `entitiesByKey`，并不意味着快照历史完整。顺序以 islands 数组及每岛 entries 为准，不能遍历 map 或按 turnId 排序；与暂态 `conversation.turns` 合并还需明确去重和覆盖规则。客户端完整性检查同时检查每个 turn 的 `itemsPagination.hasLoadedOldest`；canonical 历史还要求 `history.isComplete` 且只有一个 island。旧形态另看 `turnsPagination.hasLoadedOldest`。已有 `recordedTurns()` 为精确 ID 查询设计，不能直接用其拼接顺序作为完整时间线。

后续实现需单独定义：有界 snapshot/patch 缓存、明确的历史缺口、绑定 route/session 的分页游标，以及取消/超限/owner 换代行为。不能每次 Web 两秒轮询都请求全量加载；不能把 `{revision}` 当作历史正文或已完整加载的证据，也不能在翻页失败后将同一个 cursor 转投另一 reader。此处是约束，不是已实现的能力。

原客户端等待的是同一 owner 的已应用 stream revision 达到响应 revision，然后再读取状态并验证完整性。仅收到 response 不足够。完整加载会填充原 owner 的历史缓存；外部连接超时或取消，不等于已经取消 owner 内部的加载工作，目前未核实这种取消传播保证。

### 模型设置的真实来源

`thread-follower-read-model-settings` 的 owner handler 明确返回：

- `model = latestCollaborationMode.settings.model ?? latestModel`
- `reasoningEffort = latestReasoningEffort`
- `modelProvider = modelProvider ?? null`

原 snapshot 的 `conversationState` 来自同一 store，传输投影为 `Object.fromEntries(Object.entries(state))`，没有额外字段白名单；上述顶层字段确实进入当前版本的 wire 数据。patch 也转发 store 产生的路径，投影必须同时处理叶字段及父对象的 replace/remove，缺失和 null 不能错误地保留旧模型。

`DesktopObservation` 现已单独提供这三个可选值，保留桌面来源、可用性与原观测时间；原 native model/status/loaded/send 不改写。展示层选择来源时，模型、provider 和推理强度作为同一来源的一组，不将两个来源的字段拼接。2026-10-12 对精确主任务的真实 settings/snapshot 核查一致，模型 patch 由 framed fixture 验证；没有为验收改变用户模型，也未声称采集了真实模型变更。见 [模型观测实现与验收](../2026-10-11-desktop-model-observation/VERIFICATION.md)。尚未更新运行服务。

### 静态锚点与本轮验证

同一归档内 UTF-8 字节偏移：

| 文件 | 偏移 / 依据 |
| --- | --- |
| `src-BJv5Mk7n.js` | 7809 / follower 版本表；527364 / load-complete handler 返回 revision |
| 同上 | 532099 / owner `getCompleteConversationTurns`；130065 / `Ao` 历史完整性判定 |
| 同上 | 128943 / islands 有序展开；129120 / 暂态 turns 合并；351166 / 同 owner revision 等待 |
| 同上 | 528302 / model settings handler；355014 / store 状态发送 snapshot |
| 同上 | 590600 附近 / latestModel、modelProvider、latestReasoningEffort、latestCollaborationMode 更新 |
| `main-CqEoQDOU.js` | 721149 附近 / snapshot 与 patches 信封；744756 附近 / 无白名单状态投影 |

研究阶段主任务独立读归档核对上述方法、模型表达式、完整性检查和 snapshot 投影，未执行归档中的代码。该阶段 `go test ./pkg/codex ./pkg/client` 通过（codex 4.482s，client 22.011s），仅补充研究记录；这不是新历史 reader 的验收。后续模型实现与最新验证单独记录于上方链接，不改写研究阶段事实。
