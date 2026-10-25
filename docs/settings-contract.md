# 设置与运行资源契约

日常设置仅三组：模型、记忆与偏好、外观与诊断。回复和通知习惯属于 preference；执行边界是程序行为，定时条件属于任务。高级资源编辑折叠于模型组。

## HTTP

Controller 对浏览器提供以下同源认证接口。Gateway 内网管理服务提供相同路径（去掉 `/v1`），只接受 Controller Bearer token。浏览器不能指定代理目标。

- `GET /v1/settings` → `{scopes: ModelScope[], chats: Chat[], diagnostics: Diagnostic[]}`。Controller 合并本地及 Gateway 数据；Gateway 不可用时保留本地数据并明确诊断。
- `GET /v1/settings/models?scope=wechat` → `ModelCatalog`。可选 scope `controller`、`background`。
- `POST /v1/settings/models/refresh` body `{scope}` → `ModelCatalog`。
- `POST /v1/settings/models` body `{scope, model, reasoningEffort, expectedRevision}` → `ModelScope`。
- `GET /v1/settings/resources?chatId=...` → `{resources: Resource[]}`。不传 chat 时只返回实例资源；记忆必须明确 chat。
- `GET /v1/settings/resources/:id?chatId=...` → `ResourceDocument`。
- `POST /v1/settings/resources/:id` body `{chatId?, content, expectedRevision}` → `ResourceDocument`。

Browser POST 必须 `Content-Type: application/json`、`X-Super-Leader-Intent: settings-update`、Origin同源。版本冲突409；非法输入400；不支持/无权限403；未知资源404；依赖不可用503。错误JSON `{error: string, code?: string}`。不传任意文件路径。

## 类型

```ts
type ModelScope = {
  id: 'wechat' | 'controller' | 'background'; label: string;
  model: string; reasoningEffort: string | null; revision: string;
  editable: boolean; effect: string; provider: string;
};
type Chat = {chatId: string; label: string; threadId?: string};
type Diagnostic = {id: string; label: string; value: string; status: 'ok' | 'warning' | 'error'};
type ModelCatalog = {
  scope: string; models: {id: string; label: string; reasoningEfforts: string[];
    defaultReasoningEffort?: string; contextWindow?: number}[];
  fetchedAt: string; source: string; version: string; stale: boolean;
};
type Resource = {
  id: string; kind: 'prompt' | 'memory' | 'skill' | 'tool';
  title: string; scope: string; path: string; revision: string;
  version: string; editable: boolean; effect: string; reason?: string;
};
type ResourceDocument = Resource & {content: string; language: string};
```

资源 ID 需 URL 安全，Gateway 使用 `gateway.` 前缀，Controller 使用 `controller.` 前缀；子文件分别作为 resource，path展示目录层级。revision 为实际内容/设置摘要，保存以CAS检查实际当前值。version包含可识别的包/CLI/资源版本，未知版本明确为 unknown，不能伪造版本。

## 生效与持久化

Gateway 负责微信实际 SP、AGENTS、memory、Skill overlay、工具元数据及模型。Controller 负责其内部 SP、工具与后台模型。每份资源仅一个实际持久化来源，运行时明确读取它。执行轮冻结模型、推理强度和提示词；修改从下一轮生效。Skill必须包含 Skill.md 及UTF8子文件，保留脚本执行权限；二进制只读并解释原因。工具schema编辑须在实际暴露及调用校验中使用，工具身份与真实dispatch实现不可凭schema新增。

主题使用本浏览器的明暗/系统偏好，入口不增加业务Tab。诊断展示连接、组件版本、模型目录更新时间及可测请求耗时，不暴露凭证。

## 验收

验证读取→编辑→保存→重载→实际运行消费；409草稿保留；聊天隔离；非法路径/符号链接；模型来源与认证一致；不支持值不保存；资源版本和生效时间可见；手机布局无横向溢出。合并前同步最新主干，审查完整diff并完成运行界面验证。
