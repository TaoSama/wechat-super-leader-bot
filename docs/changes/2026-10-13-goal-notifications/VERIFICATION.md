# 目标通知验收

日期：2026-10-13（Asia/Shanghai）。设计见 [TECH.md](TECH.md)。本文件区分开发验证、正式发布及手机收取；不得用模拟微信冒充真实外发。

## 当前交付

- Controller 对目标 active 首次转 completed/blocked/expired，在同一 CAS 事务插入通知；取消不通知，blocked 后到期/取消保留首次事件。
- 计划/目标共用 outbox、管理 HTTP、TTL、永久领取及回执；唯一来源合同 source(type,id)，不保留旧 API 或开关兼容。
- 旧记录事务迁移 executionId→source(plan)，其余状态、attempt、文本与时间不变。目标终态不回填。
- Gateway 开关统一为 GATEWAY_NOTIFICATIONS / --notifications，默认关闭；解析/领取严格比较来源，不重复微信发送。

## 开发验证

最终 `node verify.mjs --suite unit`：PASS 13 checks，包含四组件测试/构建、CLI 工具、Go race/vet/跨平台构建。Controller 59 文件、882 项测试及 Gateway 130 项测试均通过。`node verify.mjs --suite integration`：PASS 6 checks，已包含最终新增的真实 PG 外键和来源约束断言。`git diff --check` 通过。

真实临时 PG 验证覆盖：旧 schema 四种通知状态及完整行逐字段保留；最后一行非法时前面已转换 JSON 与 DDL 全回滚；重复 init 不变；旧 expired goal 不回填；source XOR/id/kind/FK 约束。目标 outbox 插入失败回滚状态；双连接 CAS 与 claim 各一个赢家；blocked→expired 保留原 uncertain attempt；取消静默；跨聊天隔离与重连不重领。

整链使用真实 Controller HTTP、模型协议桩、WS 精确完成回执、临时 PG 与真实 Gateway 类；微信 fetch 只允许合成 .invalid 端点。目标 completed 必须来自两步执行/决策链，不伪造完成记录。已验证持久通知先领取再外发、无 context/默认关闭不领取、取消静默、丢回执后 uncertain、Controller/Gateway 重启不重发。临时 PG 和合成状态目录由验收脚手架清理。

独立协作者审查 Controller 迁移/CAS、Gateway 严格合同与根测试断言，未发现高置信阻断问题。该审查不代替执行结果或生产安全保障。

## 发布预检

源码固定为 `0230727a1dbc7d51a5922a2266fc5f782e62c274`，已推送。两个镜像由本机 arm64 构建阶段产出 linux/amd64 运行镜像，经带 pipefail 的 save/gzip/SSH/load 流式传输到香港，未生成镜像备份包或在香港构建。

本机首次调用 `docker buildx build` 返回 exit 125 / `unknown flag: --platform`，尚未开始构建、未影响线上。临时使用官方 Buildx v0.38.0 darwin-arm64，下载 SHA256 与 GitHub release digest 一致：`85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344`。未安装系统插件或修改 Docker 配置。

发布脚本独立审查发现迁移前失败恢复不完整、运行环境比较太晚；已增加提前 runtime 文件检查、Compose/image/运行环境三方比较、进程继承旧/新通知开关零操作拒绝，以及迁移前原 bytes/tag/容器恢复。迁移开始后禁止未知状态下回退旧二进制。主控独立复跑本地 mock 故障注入：11 tests / 25 子场景 PASS，未调用生产、Docker 或凭证。脚本 SHA256=`2addc4bfa9abd4983a6f31163284ed7cd201b207df90456c1522ccb91909aff3`；测试 SHA256=`866978aa8c2ee7b5196948dac237c3f85a3b9ee19f81a7d4590db6b7e7baeadd`。

正式只读 `candidate-inspect` 已通过：镜像架构与源码 label、旧容器身份/部署文件摘要、解析运行环境一致；23 commands、39 messages、1 goal，命令/聊天/计划/目标均无未决授权。没有启动候选容器或改正式配置。

## 正式发布、保护退出与独立复核

产品 `0230727` 的 [CI 38301190490](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38301190490) 全部通过：macOS unit 13 checks / 1m38s、Ubuntu all 16 checks / 7m29s。香港 Controller/Web 与 Gateway 已成对运行该版，通知开关为 true；Air `08e260a`、Mini `ef32a2f` 本轮未更新或重启。

| 运行产物 | 镜像 ID（香港 linux/amd64 manifest） | 容器 ID |
| --- | --- | --- |
| Controller/Web | `1fa3bb219c2f1ade15b7ad9f5aedf75e5c94a81988ab3bc5a4f32eec617908dc` | `dac07ce1669a6dcc1524853d225ae5dc8b302c26c484cd7804f35d90c5125e0e` |
| Gateway | `dab59b7107b4bf62bf1fd1dc655bcd41d6ead19d68f6163c8700792ec9ad5663` | `e2eada1635065fc08e1b30e373b3772e0cd58c58669312c9fff56ac81b443377` |

PG 仍是原容器 `3e627fbfc5d49081c274d0c6fc2ad7785064a0728c0aa22766ad91c566c0fee3`。两个候选的 revision label 均为完整源码提交；本机 manifest-list ID 与香港单平台 manifest ID 不同，不能混作镜像不一致。

正式脚本已输出 drain-PASS、migration-PASS：所有非通知业务整行摘要恒等；唯一旧通知只将 executionId 改为 plan source、增加 goal_id=null，其他完整字段恒等；账号及 checkpoint 字节在重新启动 Gateway 前恒等。随后新 Gateway healthy，但在 HostConfig 全对象比较处保护退出，`stage=gateway-start / AssertionError / container-host-config-changed`，因此原脚本未宣称 paired-release-PASS。两服务已运行，不回退数据库、不再重启、不重发。

脚本原 HostConfig.Mounts 没有按 Target 归一化；旧容器已被 Compose 移除，原快照仅在退出进程内，不能追回本次具体差异字段。不能把挂载顺序当成已证明的生产根因。临时脚本随后补按 Target 比较和仅输出差异字段名；主控复验 16 tests / 33 子场景 PASS，真实 Source/ReadOnly 改变仍拒绝。修订脚本 SHA256=`6005e6f7c832485c1883de2aecbf09cf94e68417f96e16f16a4e43ba53648043`，测试 SHA256=`4bb91bf65565097a9e841f4aed0557c10baed3a6894e11db1b3639008b0334db`。没有为了测试诊断再次部署。

独立只读 reconciliation 按固定源码镜像、三份部署文件 hash、当前 Compose/image defaults 和运行 inspect 重新核对：完整环境、启动入口/用户/健康命令、只读根目录、无特权/额外 capability、内存/CPU/PID、日志/tmpfs、端口/网络、账号只读及 state 可写挂载、600s 停止预算、唯一 Gateway 均通过。第一次验证器把 Compose 的 mem_limit 字符串直接同 Docker 数字比较而失败；独立投影确认值相同（Controller 536870912、Gateway 268435456），转换整数后复验通过，未改生产资源限制。

最终 reconciliation 输出 `independent-runtime-reconciliation-PASS`：三容器 healthy/restarts=0，原微信 baseline 时间 `2026-10-11T08:42:03.152Z` 保留，最新成功轮询 `2026-10-12T20:10:44.577Z`，run=`run_1791835671985_42ff6959`，入站错误0、处理消息0。这仅证明此次有限观察，不是长期稳定或通知送达。

| 业务整行摘要 | 切换前后 MD5 |
| --- | --- |
| commands（包含 input_receipt） | `e49587b2320849a25bf9fb6081c0899b` |
| messages | `8f80768801a65edfd281c1babde6c073` |
| leader_states | `892b0d2918f79df58cdf96a9939c5339` |
| leader_executions | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_goals | `bdf2d9b607f5523de6aa09dd5e32a1f2` |

正式 HTTPS 独立核验 `2026-10-12T20:08:16.592Z`：Air/Mini connected，模型 `gpt-6.1-sol`；原目标 completed/两动作不变，专用 fixture 仍归档；原通知 `2911e3f7-b9ad-4cbe-9c62-5c2593bd512c` 为 plan source、uncertain，attempt 仍 `241d61ae-1aa1-4070-bbd9-112d14af0b47`；旧目标通知 GET 返回404，无回填。主会话 control-socket 分页 limit=2 返回1条、正确来源/context。正式 Web `/assets/index-D0G0MZ4s.js` 与已验证本机构建字节一致；没有再次发送业务消息。

Air 的真实持续目标两轮结果见 [独立证据](../2026-10-13-live-goal/VERIFICATION.md)，它在通知实现之前完成，没有因升级补发通知。回退必须使用支持 source 合同的版本，不能直接切回旧 Controller/Gateway；保留 PG/通知/凭证/checkpoint/journal。

## 限制与清理

后续真实运行增量见 [LIVE.md](LIVE.md)：新目标已完成，正式 Gateway 首次尝试后为 `uncertain` / `ILinkSendMessageError`；没有重发。下面的“本轮”专指上述产品发布，后续复用会话及业务新增在 LIVE.md 单独记录。

尚未证明：新目标通知的真实微信 API 受理或用户手机收取。accepted 仅代表接口受理，不是送达或已读；claim 后崩溃可能漏发。文案仅静态事件，当前状态需查询。

本轮没有新建或解归档测试会话、原会话派发、重建基线、修改 App transport 或系统配置。两个既有协作者均已结束；本地集成测试临时容器已清理，正式 PG 和构建镜像保留。发布与验收临时脚本、下载工具在证据落盘后清理，不创建备份。建议后续发布规范将 Docker 挂载按目标归一化，并在退出前记录脱敏差异字段摘要；本轮没有擅改全局规则或技能。
