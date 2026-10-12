# 微信计划通知启用与未知回执

日期：2026-10-13（Asia/Shanghai）。以下现场时间为2026-10-12 UTC。用户已授权微信外发；本轮只启用既有计划终态通知，不新增计划或会话，不向原工作会话发送测试内容。

## 启用前核验

- 17:23:27全量PostgreSQL只读事务：21条命令（19completed、2failed），无未决命令；4条聊天状态均无claim/pending plan；1个completed计划；唯一通知为pending且没有attempt。没有使用有数量上限的状态页代替全量审计。
- 17:24:59从原Gateway加载既有账号/checkpoint，只读查询当前账号本人的待发通知；允许名单过滤后恰好1条。通知接收者等于账号本人，存在context，baseline已建立、身份fingerprint匹配。context存在不证明它仍有效。
- 通知ID/计划ID：`2911e3f7-b9ad-4cbe-9c62-5c2593bd512c`；事件截止`2026-10-13T14:50:18.031Z`，正文仅为：

```text
计划 2911e3f7-b9ad-4cbe-9c62-5c2593bd512c（共 2 步）：所有步骤已收到精确完成回执。
```

- 启用前向用户说明会发送这条既有待发提示，不把它当成仅对未来计划生效。没有通过claim或发送接口进行探测。

## 配置切换

私有`/opt/super-leader/.runtime/controller.env`原有9行，末尾有换行，未定义通知开关。通过远端标准patch追加唯一一行`GATEWAY_PLAN_NOTIFICATIONS=true`，禁止创建备份；内存中比对原字节前缀、owner与0600权限恒等。没有下载或打印私有配置。

完整Compose解析前后只允许Gateway环境的该值由false变为true，`config --quiet`通过。本地tag与原容器实际镜像ID一致，没有构建或拉取镜像。原Gateway正常停止，17:25:46退出0、OOMfalse；采用无限正常退出等待，不在超时后强杀。

```sh
cd /opt/super-leader
docker stop --timeout -1 <原Gateway精确容器ID>
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat up -d --no-deps --no-build --pull never gateway
```

现场使用等价的`--time -1`，Docker提示该拼写弃用但正常退出；上方命令使用推荐拼写。

| 项目 | 启用后身份 |
| --- | --- |
| Gateway容器 | `b2f36bb853ca07b6e73cafd6bf0c409046f570dbc6c9aab8fdb819b84e36221b` |
| Gateway镜像（未换版） | `sha256:f5b861b56bf35baeb0751240f6d3bcaf1008c9422172a0774714ea46720bd623` |
| Gateway启动 | `2026-10-12T17:25:47.453172712Z` |
| Controller（未重启/重建） | `f445b05d3e83628bd71a75f0a888cbb29fe12eaefdc496e699e8518a7fc3c4f8`，启动`17:00:54.870039125Z` |
| PostgreSQL（未重启/重建） | `3e627fbfc5d49081c274d0c6fc2ad7785064a0728c0aa22766ad91c566c0fee3`，启动`2026-10-11T05:56:45.930299545Z` |

切换脚本在启动后第一次检查失败：它把Docker的Mounts数组顺序也当成身份。只读inspect证明两条挂载仅顺序变化；改为按Destination核对Source/RW/Type/Propagation后通过，未重复重启。账号只读挂载、state可写挂载和镜像都不变；Controller/PG身份、启动时间与restartCount不变。

## 真实结果：uncertain，不重发

17:26:16通过正式HTTPS管理GET读取唯一通知：

```json
{"status":"uncertain","attemptId":"241d61ae-1aa1-4070-bbd9-112d14af0b47","attemptedAt":"2026-10-12T17:25:48.382Z"}
```

不能将它描述成微信接口已受理，更不能描述成手机收到。部署版本在发送异常时只持久化uncertain，没有保存错误类别，当前容器日志为空，因此不能追溯本次究竟是网络异常、缺少明确成功码还是接口拒绝，也不能猜测context已过期。询问用户是否收到仅补充手机观察，不改写接口回执。

没有再次claim、直接补发、删除记录、重建checkpoint或创建新计划绕过未知结果。原通知永久保留同一个attempt。通知功能保持开启，今后新计划依原合同处理；这条记录不会自动重放。

17:26:59全量只读审计：只有通知表摘要变化为`c6d5deec003490f2d6dc72b4ac634bbf`，唯一记录为uncertain。其余业务数据与启用前恒等：

| 表 | 行数 | MD5 |
| --- | ---: | --- |
| commands（排除input_receipt） | 21 | `3d751606f40ad9c773b01d9942d2b701` |
| messages | 35 | `6664c32116ecc134e66298d7ac0fa489` |
| leader_states | 4 | `c76f3101ef9acac290faa1d3e558663e` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |

原账号字节恒等；baseline时间仍为`2026-10-11T08:42:03.152Z`，8个去重key、1个context、非空cursor保留，无未完成回复分段。三服务healthy/restarts0。新run为`run_1791825947876_2558bb02`，最近成功轮询`17:26:45.568Z`，入站处理0、入站错误0；这个健康计数不覆盖通知失败，不能当作通知成功证据。

## 验证与限制

- `docker compose … config --quiet`与只允许一个Gateway环境字段变化的内存对比通过。
- `docker exec super-leader-gateway node dist/index.js --check`：配置有效、`planNotifications=true`、baseline ready。
- `docker exec super-leader-gateway node dist/index.js --healthcheck`：通过；另读取health文件核对真实成功轮询，不把starting/processing单独当成功。
- `GET /v1/notifications/<上述ID>`与全量PG审计一致，为同attempt的uncertain。
- `node --test deploy/gateway.test.mjs`：6/6通过。
- 启用前辅助检查曾把模块名误写为`dist/controller.js`，在HTTP调用前因模块不存在退出；改用真实`dist/controller_client.js`后通过。前轮构造参数误写也在HTTP前失败，不是生产缺少凭证。

## 诊断补丁与回归

产品提交`3a750e79c843864f2c123187809d80a38d10551c`：Gateway发送失败后仍先保存uncertain，再写结构化`notification_send_failed`事件。字段只有已校验的通知UUID、attempt UUID和既有`sanitizeErrorType`分类，不打印原始异常、stack、聊天身份、正文、token或context。没有新增claim/send重试，也没有修改Controller、数据库合同或普通微信回复。

独立审查发现初稿的`stderr.write`同步try/catch挡不住异步EPIPE：关闭管道读端后，write已返回仍会发生未处理error。最终使用同步fd2写入，短写/EPIPE转专用错误；runLoop停止并跳过同一坏stderr的错误回调，CLI明确退出2，finally保存stopped。不声称成功写入诊断，也不静默继续。真实child测试证明：退出2/无signal、回执uncertain、仅1次发送、0次新轮询；再次运行CLI发送仍为1次。独立复审原P2关闭，无新增P0–P2。

| 验证 | 结果 |
| --- | --- |
| `pnpm --dir gateway test` | 主任务112/112 PASS，956ms |
| `pnpm --dir gateway run build` | PASS |
| `pnpm --dir controller run build` | PASS，未修改Controller产品代码 |
| `node test-integration.mjs` | 修正测试时序后完整PASS；真实临时PG/HTTP/WS、模拟微信，无生产发送 |
| `node --test deploy/gateway.test.mjs` | 6/6 PASS |
| `node --test --test-name-pattern='closed real stderr' gateway/dist-test/tests/notification-delivery.test.js` | 修正fixture时钟后独立1/1 PASS |
| 文档相对链接 / `git diff --check` | 40条存在 / PASS |

保留两次失败及根因：

1. 第一轮整链在取消计划的控制台断言中得到active而期望cancelled，尚未执行通知验证。源码和独立运行的`StatusEvents`均证明HTTP可共享取消前已开始的SSE快照；下一次读取为新状态。`test-plan-console.mjs`改用既有25秒/100ms等待精确HTTP状态与步骤，每次仍检查200/schema，随后严格核对SSE逐字投影。不改产品或延长超时，重跑整链全部通过。
2. 首次镜像烟测的合成claim分开调用两次Date.now，产生超过60000ms的attempt区间，被严格schema拒绝。改为单次取时后完整烟测通过；同样修正新增child fixture的潜在毫秒竞争。没有放宽生产校验。

从该固定提交的`git archive`在Air本地构建linux/amd64 Gateway；复用既有临时buildx v0.38.0，执行前SHA256仍为`85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344`，未安装插件或改系统。构建上下文不包含私有运行文件。

- 镜像`super-leader-gateway:3a750e7`，image ID `sha256:4eda73ea285e741727f8ae703cf3ecd0316838034a84a81c86ce145699d5f426`，linux/amd64、USER node、revision label为`3a750e7`。
- 断网只读容器烟测：Node24.21.0/x64/UID1000、network none；真实编译Gateway与客户端、仅合成传输/账号。输出PASS：send/claim/receipt各1、uncertain、重建Gateway后未重发，诊断字段严格匹配且无私密内容。容器`--rm`正常退出；不是实际微信送达验证。
- 使用`docker save | gzip | ssh … docker load`流式加载到香港，没有生成tar或备份。香港image ID与全部11层一致，层列表换行连接后的SHA256为`da72b23956a384deb8485ffb86b645b959363f0de529f842576f371d3541c172`。

本次原错误无法事后补取；真实手机收取/入站与内置浏览器仍需用户参与，不由模拟请求冒充。

## 补丁上线与最终复核

产品提交的GitHub CI [38285721694](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38285721694) 全通过：Ubuntu all 6m27s、macOS unit 1m46s。后续fixture单次取时仅改测试，不改变上述镜像产品字节。

17:44:55全量审计与启用后的五表摘要相同；17:45:13管理HTTPS也确认原uncertain/attempt恒等。切换前再次严格检查没有未决命令、聊天claim/pending plan或active执行，通知仅1条且为上述永久uncertain。它不是可重领的待办，不通过清除数据来“排空”。

17:47:34正常停止`b2f36bb853ca`，exit0/OOMfalse，停前后全量摘要恒等。将已验证候选tag到`super-leader-gateway:latest`后，只执行gateway的`up --no-deps --no-build --pull never`。新容器：

```text
8fb91a381076cf09a57a460567926078a972830be38ecbff9dfd837af692991c
image sha256:4eda73ea285e741727f8ae703cf3ecd0316838034a84a81c86ce145699d5f426
started 2026-10-12T17:47:35.456149632Z
```

启动后脚本PASS：仅Gateway容器/镜像变化；账号和env字节恒等，挂载按Destination比较完整相同，Entrypoint/Cmd/User/Healthcheck及全部环境保持不变。Controller/PG未重启，五表摘要仍恒等。`--check`为配置有效、通知开启、baseline ready。

17:49:12–17:50:22独立只读观察三次（间隔35秒），始终只有一个正式Gateway，healthy/restarts0；run ID为`run_1791827255795_16096e28`。最后成功轮询时间推进至`17:50:09.421Z`，入站错误0/消息0，8个去重key/1个context和原baseline保留。三个样本PG中的通知均为同attempt的uncertain，正式HTTPS17:49:09独立一致，未生成新通知或执行请求。17:50:45最终全量审计五表摘要仍恒等。`--healthcheck`通过；日志为空是没有新通知失败事件，不是追回首次未知回执的证据。70秒观察不代表长期稳定。

两个协作者均已收口，原P2修正经过独立复审；本地整链临时PG、模拟HTTP/WS、fixture进程正常退出，`docker ps -a --filter name=super-leader-test-`为空。构建工具为已存在的临时工具，无本轮新增安装；候选镜像作为必要产物保留。

没有创建备份、临时脚本文件、测试Task或额外Gateway；没有修改Mac服务、App连接方式、数据库结构、系统配置。停用只将同一开关置false并正常更新唯一Gateway，保留通知和checkpoint；停用无法撤回已开始的网络请求。完整目标仍为active。
