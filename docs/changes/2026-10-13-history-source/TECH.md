# 大历史显式分页与紧凑筛选

## 问题与边界

桌面 follower 接口提供整份会话快照，Web 的 limit=30 不能减少其原始帧。本次只读探针收到 52,405,498 字节的帧声明，在读取正文前按 32 MiB 上限拒绝；另一目标在 follow-stream 超时，不能归因为同一大小问题。

现有控制 socket 已支持 `thread/read(includeTurns=false)` 和 `thread/items/list` 分页。复用这个只读接口，不新建 server、不 resume、不修改桌面 transport、不改 writer 或发送资格，也不提高帧上限。

## 合同

- HTTP 历史请求可显式携带 `source=control-socket`，其他 source 值拒绝。默认路由不变，不静默换源。
- Web 错误区提供“使用分页历史接口”；切换时取消旧请求、清空旧页和游标，从新 historyContext 开始。迟到响应不得写入新阅读窗口。
- 一个 context 固定 node/session/source；来源冲突返回 409，省略 source 仍沿用绑定。Controller 与 Web 均核对显式请求的响应来源。
- Terminal 会话不能使用该参数调用原生 Codex 适配器。
- 页面标注已保存记录可能延迟，历史接口不提供发送资格。恢复自动来源同样建立新 context。
- 413 保留已读内容，暂停定时、恢复可见及近顶滚动的自动读取；手动重试仍可用，成功后恢复自动更新。
- 桌面原始帧仍限 32 MiB；控制接口单帧仍限 8 MiB。接口不存在或单项仍超限时明确报错，不返回半份内容冒充成功。

## 筛选

机器/状态共用原生 select：桌面 32px 高、自然宽度，最大分别 180/156px，不被 flex 拉满。小屏或粗指针维持 44px 点击高度，保留键盘焦点和系统选择语义，不做全站视觉重构。

## 发布边界

Controller/Web 与 Air Daemon 需同版部署才提供显式分页。Mini 没有该控制 socket；本改动不会凭空提供接口，仍可使用原桌面历史。回退不得清理 journal、PG、微信 checkpoint 或未知回执；持续目标活跃时不能退回不识别目标的旧 Controller。
