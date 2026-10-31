# Gateway 通知循环网络错误诊断

## 已确认的问题与尚未确认的根因

发布前生产 revision 为 `432ba902c0ce370d97a4fb7c79db41f54f32fd64`。只读复核 Gateway 日志确认 2026-10-31 北京时间 20:03:09、21:28:29、21:42:39、21:58:48 四次 `notification cycle error: NetworkError`。Controller、Gateway、PostgreSQL 均 healthy、restarts=0。旧日志没有请求操作及底层 cause，不能从这些事实判断 DNS、TLS、连接复用或正文流是哪一个出错。

`sanitizeErrorType` 将 TypeError 统一归类为 NetworkError；独立通知循环失败后继续下一轮，CLI 不把它记成入站 poll 错误。因此原 healthcheck 和 `total_error_count=0` 只能作为入站轮询的证据，不能证明通知循环已经恢复。本次保留这些既有语义，只补观测。

**生产历史错误的真实传输根因仍待自然复发确认。** 本次不声称修好了生产网络，不发送微信，不重跑或修改生产任务，也不通过重启制造成功证据。

## 新日志说明

- `notification_cycle_failed`：固定阶段名与操作名、fetch/headers/body/decode/validate 阶段、HTTP 状态、整个请求耗时、已尝试/最多尝试次数、请求截止/父取消标记、原有错误分类、固定错误名称和 cause code allowlist。另有本轮失败请求摘要（最多 8 项）、未解决数、证据溢出标记及下一轮重试间隔。重试沿用现有循环，不新增网络重试。
- `notification_cycle_ready`：当前进程首次完整循环成功时一次；若此前失败，先等待对应请求成功和完整循环结束。
- `notification_cycle_recovered`：所有被观察到的失败请求都已出现匹配成功证据，并有完整循环成功后一次。HTTP200 后正文/JSON/schema/身份校验失败均不是成功。不同收件人成功、缓存/额度导致跳过请求、单独 poll 成功均不能清除失败。

异步上下文记录本轮全部请求失败，保留 Gateway 原 firstError 抛出顺序。请求成功需完成原有结构/身份校验；校验失败不会新增回执重试。请求身份仅用于进程内哈希匹配，不输出。cause 链与 AggregateError 有遍历上限并处理循环引用；未知代码统一为 OtherCode。日志不包含 message、stack、URL、主机、账号、消息正文、token 或原 cause 对象。

没有匹配请求的本地阶段失败不自动声称恢复；超过 64 个不同失败身份时设置 `recoveryEvidenceOverflow` 并保守保留“恢复未证明”。这些诊断状态只在内存，不写业务账本、不影响调度、额度、健康判定或发送结果。生产日志仍沿用现有容器轮转限制，正常成功循环不逐秒写日志。

## 本地运行证据

独立回归涵盖 cause 循环/自定义代码、请求前失败、HTTP200 正文失败、请求截止与父取消、字节预算、回执三次上限及鉴权单次、坏 schema/身份不重试、同轮多失败、不同收件人/跳过不误报恢复、恢复一次、停止和 fatal diagnostic 分支，以及真实 Gateway 独立循环与入站健康分离。

实际 CLI 验证入口：

```sh
pnpm --dir gateway build
node tests/integration/leader/notification-diagnostics.mjs --run
```

该入口启动本地 HTTP Controller fixture、HTTPS iLink fixture 和构建后的 `gateway/dist/index.js --run`，不替换应用 fetch。先在响应头前断开真实连接，再返回 HTTP200 并中断正文，第三次返回完整合法响应；持续观察后停止自己启动的进程。

捕获的关键字段：

```text
notification_cycle_failed operation=notification_interest stage=interest phase=fetch causeCodes=[UND_ERR_SOCKET] requestAttempts=1 requestMaxAttempts=1
notification_cycle_failed operation=notification_interest stage=interest phase=body httpStatus=200 causeCodes=[UND_ERR_SOCKET]
notification_cycle_recovered recoveredOperations=[notification_interest] totalFailures=2
PASS actual Gateway CLI: socket failure before headers and after HTTP200 body, retry then one full-cycle recovery; independent inbound health; zero WeChat sends
```

请求实际发生三次；恢复事件一次；入站 `total_error_count=0`、有成功轮询、退出后状态 stopped；fixture 断言没有微信发送并清理全部临时证书、目录、端口及子进程。此入口已加入 CI integration-core。

独立复核发现的两项误报边界（只记 firstError、校验前记成功）已修正并补入回归；不把这些合成网络失败解释为生产历史根因。

## 部署、验收与回滚

沿用现有 Verify → 自动合并 → production workflow；代码、合并 SHA、镜像 OCI revision 和实际容器 revision 必须对齐。部署前后只读核对三个容器、daemon、定时配置、run/worker/outbox 计数；保留 23 小时窗口、第 22 小时提醒、共享 10 条额度，Controller 单 runtime 根/单 named volume 和 PostgreSQL 独立卷。

上线后首个 `notification_cycle_ready` 证明新代码完成过一轮通知处理。没有自然失败与恢复配对时，不能报告生产网络根因已定位或历史错误已由代码修复。若自然复发，以新事件的操作、阶段和 allowlist cause 确定下一步，不主动触发业务。

本次不变更持久 schema、生产配置或卷。需要回滚时沿用 `docs/production-deployment.md` 中现有 release env/上一版本镜像回滚流程；只回退诊断代码，无业务数据迁移。

Node fetch 的底层错误参考：[Undici 错误定义](https://github.com/nodejs/undici/blob/main/lib/core/errors.js)。本地真实 socket 断开已独立验证 cause 可观察性；具体生产 cause 仍以部署后的自然日志为准。
