# 正式发布与跨机接入验收

日期：2026-10-12（Asia/Shanghai）。用户已明确授权自动完成目标，包括项目发布。本文记录本轮实际观察；全目标仍需按 [完整验收矩阵](../2026-10-10-control-plane/ACCEPTANCE.md) 核对，不以单节点发布或绿测代替整体完成。

## 发布产物与代码交付

- 产品源码固定 `f6b2b5db4e27fe31c562c603d608561c2bbf9748`，候选构建及本地运行证据见 [发布候选](../2026-10-12-release-candidate/VERIFICATION.md)。后续 `95a9025`、`84dc12d`、`7965626` 仅修改文档或测试，产品源码没有改变。
- 私有 GitHub main 已推送至 `796562647954bd86189212de4505e2e3e3e17b8d`，推送前 fetch 确认无上游分歧。
- 香港已通过流式 `docker save | gzip | ssh … docker load` 加载 `super-leader-controller:f6b2b5d`。本机/香港 image ID 均为 `sha256:1b56007e692e6a0e21d077e5a21dfeec4e4c4c6a32995a3f19c17ed8a9b394a4`，全部 10 个 RootFS layer 一致；linux/amd64、USER node、revision 均匹配。未在香港构建、未创建镜像 tar 或备份。
- Air/Mini arm64 候选 SHA256 为 `f87e43accc0897317a8da1a8c5f83bb3d88365b25d21b2650691b5a0bb9e51e1`；Mini 已接收且独立校验通过。Linux 候选尚不能代表实机服务验收。

## CI 失败、根因与修正

1. Run `38259472210` / `95a9025`：Ubuntu Gateway 测试把 `maxAgeMs=0` 同毫秒的成功记录误判为过期；macOS 三项大帧测试的 fixture 连接在 3 秒后关闭，早于解码/退订完成。`84dc12d` 使用固定时钟验证 0ms/1ms 边界；大帧 fixture 写完 body 后清除自身读期限，保留产品 timeout 和完整正确性断言。不改产品 timeout，不跳过测试。
2. Run `38261236284` / `84dc12d`：macOS unit 通过；Ubuntu unit/race/vet/build 通过，Compose 检查失败：源码的 `create_host_path: false` 被旧版序列化为缺省。新旧模型分别省略 true/false，不能把缺省一律当 false。
3. `7965626` 让当前 Compose 分别规范化显式 false/true 的合成挂载，要求两者有区别且正式配置严格匹配 false；同时保留源码显式 false 检查、真实配置改成 true 的负向拒绝测试。生产 YAML 未改。本机 5.5.1 与临时官方 2.39.4：`node --test deploy/config.test.mjs deploy/gateway.test.mjs` 均 11/11；主控独立 gateway suite 6/6、`git diff --check` 通过。
4. 临时 2.39.4 二进制及专用目录已精确清理。官方 asset 元数据提供 digest，但删除前未计算本地文件 hash，不声称下载完整性已核验。CI 精确版本 2.38.2 由下一次真实运行验证。

Run [`38262955582`](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38262955582) / `7965626` 最终全部通过：macOS unit 13 checks / 1m42s，Ubuntu all 16 checks / 6m29s。Ubuntu 日志包括真实临时 PG、Go Daemon、模拟 owner、持久计划、结果传递、通知与登录整链；仍是合成目标，不代替以下正式验收。

## 排空与数据核对

14:00:42、14:27:33 UTC 两轮 PostgreSQL `REPEATABLE READ READ ONLY` 全量查询：18 条命令（16 completed、2 failed），无 pending/accepted/uncertain；4 条 leader_states 无 inflight/pending；executions 与 notifications 均 0。不是用状态页的近 50 条或最近 12 个计划代替全量检查。

| 表 | 行数 | 全量业务摘要 MD5 |
| --- | --- | --- |
| commands（排除新 input_receipt 列） | 18 | `37843ed08b3c532ed7e84cead2771856` |
| messages | 29 | `f8ff097888ef35cd89bdb37b38439a18` |
| leader_states | 4 | `527a8677248414fa78454c303f3e7252` |
| leader_executions / leader_notifications | 0 / 0 | `d41d8cd98f00b204e9800998ecf8427e` |

Gateway 正常停止后（14:34:37 UTC）、Controller 正常停止后（14:35:30）、新版启动后（14:36:45）再次执行同一只读事务：上表全部行数/摘要一致，无未决命令/claim/计划。两个旧进程退出均为 0、OOM=false；未强杀。

14:36:22 UTC 香港 Controller/Web 切为上述 `f6b2b5d` 镜像，容器 `4460349d838acbe512cfb9f25aa7f02287f6a85b0c8ca20a1745f68059bde214`。显式 tag 为 Compose 默认 `super-leader-controller:latest` 后 `up -d --no-deps --no-build --pull never --force-recreate controller`。Compose 报 Gateway orphan 仅因本次未包含其 profile；没有 remove-orphans，按精确原 ID 恢复 Gateway。

Air 稳定二进制安装后 PID 77741，SHA256 匹配；`go version -m` 为 f6b2b5d / modified=false。保留所有原运行参数、token、state-dir、journal 和技能目录，没有启用新终端参数。公网 JS/CSS 为 `index-DyMTH1BJ.js` / `index-BmkiR_3Q.css`。原 Gateway 和 PG 容器未替换，三项 healthy/restarts=0；Gateway 自检 `consecutiveErrors=0,totalErrorCount=0`，通知开关不变。

## Mini 接入前置

- `ssh macmini` 直连成功；用户 macmini / UID 501 / arm64 / Mac16,10。App PID 1304，IPC 属于该用户且权限 0600，lsof 独立匹配；未改 App transport 或重启 App。
- 精确持久目标 `01a03f11-382b-7230-a517-0f7b3400e630` 仍存在。此前两次 6 秒探针超时；14:29:56 UTC 按相同协议延长只读诊断等待至 12 秒，10001ms 收到 `no-client-found`。独立 App 归档源码确认发现期限 10 秒，需精确目标实时 owner。这只证明当前路由器找不到可处理该 ID 的客户端，不能推论整机没有 owner，更不证明持久会话不存在。
- 香港 TLS `/health` 200，证书校验通过；无认证 WSS Upgrade 为 401，不冒称认证连接成功。
- 独立节点凭据已存 1Password，经原生生成器生成并两次恒等回读验证；仅通过 stdin 注入。前两次 JSON 编辑返回成功却回读为空，已保留失败事实，未使用未知结果注册。密钥未打印或进入命令参数/本地临时文件。
- 项目注册工具 dry-run / apply 成功，仅在香港运行配置追加 macmini，macair 凭据不变。Controller 更新后安装 Mini 只读 LaunchAgent，PID 90884，候选/稳定二进制 SHA256 一致；state-dir 0700、token 0600、owner macmini。参数没有 `--desktop-send`，仅使用实际 `.claude/skills` 根，未修机器原有断链。
- 正式 Bearer 状态接口确认 macair/macmini 均 connected，各 18/1 个会话、共 165 项技能；这是真实 WSS 认证注册，不只是 TLS/无认证 401。Mini 原目标历史与发送仍未证明。

## 真实模型与结果接力

Controller `leaderMode=model`、`leaderModel=gpt-6.1-sol`。用本人 allowlist 的 chatId 经 `/v1/messages` 模拟自然语言入站，不冒称来自微信客户端。仅选择原 fixture，两步均禁止工具、文件修改和外部消息。预览确认前没有新增命令。

- 首次模型查询碰上资格 unavailable，明确没有保存待确认计划；PG 验证 pending=0、commands 仍18。第二次 helper 在提交前遇 checking，未发 HTTP。没有绕过预检或重放未知发送。
- 独立 75 秒只读采样：19 次成功中 15 ready、3 checking、1 unavailable；14:46:30 unavailable → 14:46:34 checking → 14:46:38 ready。源码与 29.876 秒观测间隔共同确认这是 30 秒 observer 窗口后的重新预检，不能用 App idle 替代资格。
- 资格恢复后重新提出预览，准确冻结两步同一会话、第二步 `dependsOn:[1] / resultFrom:[1]`，第二步任务本身不含来源标记。计划 `2911e3f7-b9ad-4cbe-9c62-5c2593bd512c`，预览 JSON SHA256 `6b1f3e7dddf23e2a29cc75ee197eacb3e752d79663087e845d5a6d42797251e5`。
- 显式确认后按持久计划推进，第一步完成到第二步发送间等待新资格；没有重发第一步。最终计划与两条命令均 completed。

| 步骤 | 命令 / 原生 turn | 精确输出 |
| --- | --- | --- |
| 1 | `cmd_25453678-ad61-4144-9045-9897e178528e` / `01a13097-39ba-7a62-9cd0-cda5304bba8e` | `SOURCE_F6B2B5D_20261012_1434` |
| 2 | `cmd_be0dc2bb-a88c-4734-b57c-ed2992fa0a14` / `01a13097-a8e6-71b3-9fbe-9668c7b60485` | `HANDOFF_OK:SOURCE_F6B2B5D_20261012_1434` |

第一步记录输出 28 字符、SHA256 `8c5c274d67e5e1ca51528d146cfea641b8e41090e772740e4750314dc66eaae6`，第二步实际请求包含对应 command/turn/hash/原文 JSON 附件，未裁剪。Controller 命令与原生 `read_thread` 最后两个回合独立一致，分别耗时 12.891s、8.625s，均无工具调用。helper 输出 `PASS exact completed result handoff, unique turns, frozen source hash and actual request`。这是同一真实会话的串行接力，不冒称已验收不同物理节点间的结果接力。

## 浏览器发现与根因核验

空间47真实 HTTPS 一次性链接自动登录，URL 清为 `https://leader.taoai.site/`，document.cookie 为空，local/session storage 均0。显示两节点与19会话，精确 fixture 模型为 gpt-6.1-sol，原会话历史可读。

随后两个观察曾阻止浏览器验收通过：

1. 会话页持续停留时，22:39:59首次加载、22:40:27读到历史、22:41:32出现上下文失效，保留内容并要求显式重新读取；22:44:17才切到Leader页。不能直接归因为 observer 轮换，历史reader是独立连接。见 [历史失效截图](history-context-expired.png)。
2. 新计划创建后，API 200 正常返回完整计划，Web 显示“持久计划状态格式无效，无法确认计划进度”并停留旧快照。浏览器同源 fetch 独立确认计划已 completed。见 [计划拒绝截图](plan-state-rejected.png)。

23:01–23:05 本地时间的独立现场核对发现，页面 `document.scripts` 实际仍为 `/assets/index-DzKo0Dzz.js`，同源无缓存读取的首页指向 `/assets/index-DyMTH1BJ.js`。此前仅检查服务器静态资源，不足以证明浏览器正在执行新版；这里纠正该假设。旧页面跨部署保留，旧契约对新增 `resultFrom/resultSources` 严格拒绝；历史 parser 对同一计划复现，首个拒绝字段为 `steps[0].resultFrom`，去除两个新字段后通过。未取得旧 bundle 字节，不冒称完成精确旧包取证。

正常 reload 后执行新版，登录仍有效且 URL 没有 token；切回 Leader 页后实时连接恢复，计划显示 2/2 精确完成、20 条指令、两节点在线，无错误横幅。见 [刷新后计划截图](plan-state-confirmed.png)。当前线上 bundle 与本地构建 SHA256 相同（`24da5ec1f77513cdfa5cbb862a6c6bfd67fa5ffa4ec9f63fae16b0105b2d6996`），完整真实计划在当前 parser 中通过。没有添加旧合同兼容层或放宽校验；部署后已打开的旧页面需要刷新。

新增脱敏回归覆盖 28 字符来源、UUID 回执、序列化/重复解析、HTTP→App 和 SSE 的 active→completed。主控独立运行 Web 全量测试：21 files / 400 tests PASS（23:04:51）。一次浏览器等待“任务计划”超时是 reload 默认回到会话页而测试驱动未切换导航，不是产品状态失败。

历史问题的独立 75 秒 live 复测在第 30 次读取（60 秒）复现：固定诊断 `reason=noise-limit delivered=true active=false ready=true load_requested=false`。持续每 2 秒调用刷新 lastUsed，排除 idleTTL；未请求全量加载，排除 load 超时。第三次分类对照在 58 秒失败，75 个正常 client-status 广播、54 个 discovery 请求、other=0，累计129帧触发保护。

修复提交 `9ef66473ed4b18dc3b5ad2fa35ce770144a4b258`：只有严格校验的两类路由控制帧不计为噪声，不重置未知消息计数、不延长历史期限、不改变 owner/revision/generation/following 校验。发现查询仅回复精确外层 requestId 的 `canHandle:false`；当前 owner 断线立即失效。新增固定原因日志不包含正文、身份、socket、context、原始错误。没有增大128阈值或闲置TTL。

- 修后同一 fixture 连续 75.00 秒、38 次读取、同 generation PASS；测试结束仅正常 reader-stopped。不是长期压力保证。
- 768 个合法控制帧后历史仍可读；13类未知/畸形消息穿插合法控制帧仍在第129帧拒绝。内外 discovery requestId 不同，验证精确外层绑定。
- 实现者 `go test ./...`、race、vet 通过；主控独立 `go test -race ./pkg/codex ./pkg/client` 为32.376s/21.990s，`go vet ./...`、Web400项和diffcheck通过。另一协作者只读评审无阻塞项，定向非live回归0.791s通过。
- 产品修复提交的 GitHub run [38268716818](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38268716818) 已全部通过（Ubuntu all、macOS unit）。正式发布与复测如下。

## 历史修复正式部署

从干净提交 `ef32a2f1eccc8146343a82046ae921f8c30008d8` 构建 Air 原生产物，产品源码与补丁9ef6647一致，额外提交仅文档。`go version -m` 确认 darwin/arm64、go1.26.4、完整revision、modified=false；候选和稳定路径 SHA256 均为 `7c6adeb00d6d043b1ebe888abd77275cd3790c29f25a31e209b307f88a9f30d9`。一次从daemon子目录提交文档的命令路径错误，未暂存/提交，随后产生的dirty候选未安装；回到项目根提交后重新构建上述干净候选。

15:15:37 UTC 全量审计无未决命令/claim/计划；通知API独立确认1条pending无attempt，Gateway环境开关仍false。正常停原Gateway（15:16:20）、原Controller（15:16:49），均exit0/OOMfalse；15:17:06停后审计的五表摘要与15:05基线完全一致。保留该通知，不删除、领取或改写记录。

只更新Air用户服务，完整保留token、journal、socket、node-id、URL、heartbeat和四个技能根；新PID437、稳定二进制hash匹配。香港没有构建/更换镜像或容器；原Controller于15:17:58恢复，原Gateway于15:19:01恢复。15:18:16数据库五表摘要仍全部一致。PG一直运行，Mini Daemon未重启，Codex App未重启/改连接方式。两节点WSS再次认证在线，三个容器healthy/restarts=0，Gateway自检errors0。

正式验证：

1. 管理HTTP对固定fixture每2秒读取limit=1，39次、92734ms，historyContext/来源/条目恒等；结束后使用首轮旧cursor仍可读取不同的更早条目。首次驱动误写来源常量`desktop-recorded`，被实际`codex-desktop`拒绝；核对协议后修正驱动，未改产品合同。
2. 真实浏览器在同一historyContext下连续242412ms、97次成功、0失败、来源codex-desktop；条目由22增至24。滚动至旧消息后刷新不拉走位置，新回复出现时保留位置并显示“有新消息·跳到最新”。fixture总条目未超过默认30，不能把本轮手动滚动冒称触发了更早页自动请求；更早页cursor由上一项实测，自动加载保留已有组件回归证据。
3. 通过Web输入框仅向同一复用fixture发送一次“只回复HISTORY_FIX_OK_20261012”，没有另建Task或向其他会话发消息。命令`cmd_eccd7bb9-e3e7-40e8-b286-e331b887ea65`、turn`01a130b4-d763-79c3-ae08-1640b459f61f`均精确completed，输出`HISTORY_FIX_OK_20261012`；原生read_thread独立核对同turn、8752ms、无工具调用。见 [历史与发送实测截图](history-fix-verified.png)。

当前修复不解除发送资格的30秒重检波动，不代表多天长稳、所有owner或不同物理机接力均通过。

15:23:26 UTC最终全量审计：最后一次Web验收新增1条completed命令，因此21条命令（19completed/2failed）、摘要`3d751606f40ad9c773b01d9942d2b701`；其余四表摘要与15:05基线完全一致。没有未决命令、claim或活动计划；通知保持pending且未领取。归档fixture后，正式状态接口不再列出该会话，两节点仍connected。

## 结果接力后的全量状态

15:05:44 UTC 再次执行同一只读事务：20 条命令（18 completed、2 failed）、32 条消息、4 条聊天状态；没有未决命令、claim 或待确认计划。1 条两步计划 completed；对应通知仍 pending、未领取且结构有效，通知开关继续 false。该通知不代表执行未完成，不删除或手动改状态；后续开启通知前须重新确认其范围与期限。

| 表 | 行数 | 全量业务摘要 MD5 |
| --- | --- | --- |
| commands | 20 | `32597d8913c2948b2330215848f4652c` |
| messages | 32 | `c53c4a5772cc2318dac8a6fdf661a407` |
| leader_states | 4 | `2584be986dfbe98714b75af4a7321c85` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_notifications | 1 | `8b418d890b46446adc71c839da339f0c` |

再次提交相同确认 messageId 返回 HTTP 200，命令总数 20→20、原计划不变；没有生成新的执行步骤。上述新状态取代首次发布的 0 计划基线，下一次切换仍需重新全量核对。

## 测试资源与剩余门槛

复用原专用会话 `01a12a91-5777-75e0-8df3-4ee968565997`，未新建Task；两步接力与最后Web测试均终态后已归档，保留历史供下次复用。浏览器复用空间47，最终退出登录后`/auth/session`返回401、URL无hash/query、local/session storage均0；`finish({keep:[]})`确认空间关闭。未遗留测试登录或后台live测试进程。

本轮临时目录`/tmp/super-leader-release.BQsC2s`及未安装的dirty测试二进制`daemon/bin/super-leader-daemon-history-fix-darwin-arm64`已通过系统trash移至废纸篓，原路径不存在，可恢复；目录不含落盘秘密。正式ef32a2f候选、安装服务、数据库、token、journal与证据截图保留。两位协作者已结束，无新增Agent。浏览器提示Ego Lite有更新，本轮未升级。

Task目录另一路核对：主Task已归属正确项目，但cwd仍ordinary。此前5个归档目标的第一个移动接口返回`The task is not available in the sidebar.`，未继续尝试其余目标、未解归档、未改数据库；项目归属1/6与cwd迁移0/6分别记录，不能混为完成。

真实微信入站/内置浏览器、Mini owner 控制、公司机器边界、Linux 用户服务、真实 CLI 精确完成、持续动态自治及长稳仍需独立证据。不会删除状态绕过 uncertain；写入新合同后需同合同修复版本，不能盲目降级旧 Controller/Daemon。
