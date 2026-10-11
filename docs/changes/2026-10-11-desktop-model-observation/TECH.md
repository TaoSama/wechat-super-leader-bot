# 原桌面模型观测

## 范围

读取已运行桌面 owner 的模型设置，接入会话列表、详情、搜索、输入框说明以及 Leader 的只读会话查询。不启动或恢复后端，不更改 App transport，不部署，不发送测试消息。不在本变更实现完整历史加载。

协议依据见 [原客户端路由研究](../2026-10-10-control-plane/DESKTOP_ROUTING.md#历史与模型补充核验)。

## 契约

1. `DesktopObservation` 增加可选 `model`、`modelProvider`、`reasoningEffort` 字符串，沿用该观测的 source、observedAt、availability。不改原 Session model/status/loaded/capabilities/observedAt，不影响发送资格。
2. 仅投影 snapshot/patch 白名单：`latestModel`、`latestReasoningEffort`、`modelProvider`、`latestCollaborationMode.settings.model`。所有模型属性精确区分大小写，`MODEL` 等未知键不能覆盖 `model`。模型按客户端的 nullish 规则选择 collaboration model，再取 latestModel。支持父对象替换/移除和叶字段更新；新 snapshot 缺失值清空旧值。未知或坏类型不能保留旧模型或回退成已知模型。历史正文、指令、凭据不进入投影。
3. 公共模型字段有效条件：非空且首尾无空白（包括 U+FEFF），UTF-8 长度最多 256 bytes，无控制字符、孤立 surrogate 或 U+FFFD。无效字段省略，不截断成另一个模型名。model 不可用时不展示残余 provider/effort 组成的模型组；坏模型元数据不得丢弃有效状态观测或改变发送判定。
4. 新增纯函数 `selectModelObservation(session, now)` 返回 `{model?, modelProvider?, reasoningEffort?, source: "codex-desktop" | "control-socket" | "unknown", observedAt?}`。优先完整来源的桌面组：有效 model，source 正确，availability=available，ISO observedAt 非未来且距离 now <= 45 秒。否则使用有效原 Session model 及同一 Session 的 provider/effort；原 observedAt 仅合法 ISO 时保留，无效则省略。native 模型不新增 45 秒限制，明确标注为“控制接口记录”，不是当前桌面设置；若 model 不可用，返回 source=unknown。不得把另一来源的 provider/effort 补入选中的组。此函数不改写输入，不授予发送权限。
5. Controller 的 `list_sessions` 保留全部原字段，额外返回 `modelView`（上述纯函数结果），工具说明指导 Leader 使用 modelView 回答模型并保留来源；状态过滤逻辑不变。
6. Web 解析三个可选字段，列表/详情/composer/搜索统一使用上述派生规则，详情标注来源与观测时间。沿用既有观测到期 timer，无新事件也撤销陈旧桌面模型；到期导致的搜索结果必须同步更新。断连/未来时间/缺时间不补猜。保持当前视觉结构，不做主题重设计。

## 所有权与验证

- Daemon 协作任务：仅 `daemon/`，实现 wire 投影及单元/传输测试；按职责拆文件，复用已有 observer/patch framing。
- Controller 协作任务：仅 `controller/`，schema、派生 helper、Leader 输出及测试。
- 主任务：`web/`、文档、跨层与真实只读验收。主任务独立复跑 Go race/vet、Controller/Web 测试/typecheck/build。
- 测试覆盖 snapshot、override/null/缺失、父子 patch、错误 owner/revision、模型更新通知、断连保留时间、状态与权限不变、同来源选择、过期 timer、搜索、模型未知、坏元数据不解除发送限制。
- 真实核查只能读取精确现有会话；不创建/恢复/发送/归档，不输出聊天正文。模型选择器中尚未提交的本地 UI 改动不在保证范围内。

## 未解决的整体范围

本变更不能证明完整历史分页、所有独立 CLI/Claude/Grok 原进程控制、跨公司机器接入、生产部署或微信手机端最终验收。全局目标保持不变。
