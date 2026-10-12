# WeChat Gateway

WeChat Gateway 是 Super Leader 的独立微信接入网关组件。负责与微信 iLink 轮询通信并将消息转发给 Controller 的 `/v1/messages` 接口，接收回复后通过 iLink 发回用户。

## 计划与持续目标的状态通知

`--notifications` 或 `GATEWAY_NOTIFICATIONS=true` 显式开启通知，默认关闭；旧参数不再支持，旧环境变量不会启用通知。仅在完成入站基线后运行；`--check`、`--healthcheck` 和 `--establish-baseline` 即使开启也不通知。`--run` 每轮先处理通知再轮询入站，通知错误独立报告，不阻断入站；`--poll-once` 在入站周期成功后处理通知。本轮持续目标通知的合成测试不代表已部署或已真实外发。

Gateway 只交付 Controller 持久保存的文本，不生成文案、不调用模型或新建任务。唯一合同为 `source: { type: "plan" | "goal", id: UUID }`，通知 `id` 必须等于 `source.id`；拒绝旧 `executionId`、未知字段及混型。计划 kind 为 `completed/failed/expired`，目标 kind 为 `completed/blocked/expired`。目标首次从 active 离开至这三态时由 Controller 生成一条通知；取消不通知，blocked 后到期不重复。只提交已有非空聊天 context 的列表（每批128个聊天、超过时排序轮转），每轮最多4条、串行发送；没有 context 不消耗领取机会。现有 context 不保证永久可主动触达。

每条通知领取只尝试一次，领取响应丢失不发送；领取后复核通知内容、身份、context、截止与停止状态。只发送一次纯文本；普通回复与通知使用同一响应判定：HTTP 成功且 JSON 对象符合发送响应格式时，允许空对象 `{}` 或仅 `message_id`，不强制可省略的零码出现；若出现 `ret` / `errcode`，必须是数字零。非法类型、非零码、未知字段/嵌套 envelope，以及无零码却带非空 `errmsg` 的含糊响应均拒绝。不把空 HTTP 正文、非法 JSON 或响应丢失当作 `{}`。

`super-leader:notification:<id>` 仅关联证据，不是微信幂等保证。异常响应、网络异常或超时记为 `uncertain`，不重领、不重发；更新响应判定也不改写旧回执。回执提交最多3次相同请求，失败时原 claim 可通过 Controller Bearer 管理接口核查。`accepted` 只表示已取得客户端支持的成功响应，不证明用户收到或已读。诊断区分微信 HTTP 状态、错误码类型/非零码和格式异常，只记录通知 ID、attempt ID 和固定分类，不保存原始响应、微信服务端 message_id 或错误文本。

领取后崩溃可能漏发，允许名单撤销与外部发送仍有竞争窗口；不保证 exactly-once 或必达。持续目标完成是模型依据精确完成记录作出的判断，不是独立业务验收；失败、阻塞、授权到期不等于停止原会话已运行任务。更新不重置微信游标、context、去重记录或回复进度。

## 运行与容器化部署

### 容器规范与安全边界
- 基础镜像：`node:24-bookworm-slim`
- 非 root 运行：系统用户 `node:node`（UID:GID 1000:1000）
- 只读文件系统：`read_only: true`
- 权限收敛：`cap_drop: [ALL]`，`no-new-privileges: true`
- 资源限制：内存 256MB，CPU 0.25，PIDs 限制 128
- 网络边界：不发布任何宿主端口（无 `ports`），仅向外发起单向出站请求到 Controller（HTTPS）及微信 iLink API（HTTPS）
- 容器停机宽限期：`stop_grace_period: 600s`。收到停止信号后完成当前消息回复和去重记录，不继续下一条消息；未完成的批次不提交游标，重启后通过已有去重记录续接。Controller 最多 3 次 × 105 秒，整份回复发送总计最多 60 秒，另留 5 秒记录预算，单条消息处理期限为 380 秒；停机宽限覆盖该期限。
- 凭证隔离：
  - 微信凭据宿主机路径（例如 `.runtime/wechat/account.json`）以只读方式挂载至容器内 `/etc/super-leader/wechat-account.json`（权限建议宿主 `0600`），绝不打包进镜像
  - 微信同步状态宿主机目录（例如 `.runtime/wechat/state`）挂载至容器内 `/var/lib/super-leader-gateway`，读写持久化保存消息去重游标与会话 token
  - 容器环境仅注入 `CONTROLLER_TOKEN`，不注入 Controller 的数据库密码 (`POSTGRES_PASSWORD`) 或节点通信令牌 (`NODE_TOKENS`)

---

## 运维命令

香港生产环境（与 Controller / Postgres 编排在同一工程中）：

### 1. 配置校验（离线）
```bash
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat config --quiet
```

### 2. 建立新消息基线（关键运维步骤）
在网关正式开始日常循环处理之前，必须首先建立同步游标基线，以避免将历史未处理消息作为新指令误触发：
```bash
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat run --rm --no-deps gateway --establish-baseline
```
> **操作要求与防并发警告**：
> 1. 执行基线建立时，确保当前微信会话处于静止状态（无人正在发送新指令）。
> 2. **禁止在两台机器（如本地 Mac 与香港 VPS）上使用同一账号凭证同时启动网关轮询**。并发轮询将破坏游标一致性并导致消息重复处理或回复冲突。

### 3. 启动网关服务
```bash
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat up -d gateway
```

### 4. 查看日志与状态
```bash
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat logs -f gateway
```

### 5. 存活性健康检查
检查网关进程存活性及近期轮询是否正常（退出码 0 表示健康）：
```bash
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat exec -T gateway node dist/index.js --healthcheck
```
> **边界说明**：健康检查读取本地进程、真实整批轮询成功记录，以及有截止时间的 polling/processing 阶段。每条消息的去重记录完成后更新处理进度，不用定时心跳掩盖卡住的请求；超过阶段期限即报告不健康。`last_poll_succeeded_at` 只在整批游标提交后更新。健康不代表模型或跨机会话调度全链路可用，新进程会重建健康文件，既有微信 checkpoint 结构保持原样。

### 6. 停止网关
```bash
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat stop gateway
```
