# Mini 原会话加载与发送资格验收

日期：2026-10-13（Asia/Shanghai）。以下现场时间为 2026-10-12 UTC。本轮没有新增产品代码、创建测试 Task 或向 Mini 工作会话发送消息。

## 原因与原生加载路径

精确目标：`01a03f11-382b-7230-a517-0f7b3400e630`。此前 IPC 初始化成功但 10001ms 返回 `no-client-found`，只能说明该目标当时没有可处理客户端，不能推出需要共享 app-server。

独立现场检查：

- Mini 用户 macmini；App 为 `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`，PID 1304，自 10-11 19:45:56 本地时间运行。
- Info.plist：版本 `26.1007.30912`，bundle ID `com.openai.codex`，注册 `codex` URL scheme。
- 本机与 Mini 的 app.asar header SHA256 均为 `0ba43368dc2f01fcf2a29c8e02f30cc6bb879ce268c8672734504f791526ce50`。有限读取归档源码，不执行归档 JS、不解包或写入应用。
- 持久索引精确目标 `archived=0`、`source=vscode`，cwd 仍 `/Users/macmini/Documents/ChatGPT/ordinary`。系统 SQLite 普通 `-readonly` 返回错误14，文件不存在 WAL/SHM；改为 URI `mode=ro&immutable=1` 仅核实持久身份，不创建 WAL/SHM，不把它当实时状态证明，也未引入产品数据库读取。

归档内相互衔接的证据（UTF-8 byte offset）：

| entry | offset | 行为 |
| --- | ---: | --- |
| `.vite/build/src-CP7XXlpZ.js` | 15354 | 解析 `codex:` / `threads` / 精确 UUID |
| `.vite/build/bootstrap-CooIJpZm.js` | 410803 | 既有 ID 映射 `localConversation`；`threads/new` 是不同分支 |
| `.vite/build/main-CqEoQDOU.js` | 3425926 | 导航到 `/local/<id>`；无 prompt 时不预填输入 |
| `.vite/build/src-BJv5Mk7n.js` | 975641、705499 | App 正常 view 加载，历史与 runtime 恢复后设置该线程 owner |
| `.vite/build/main-CqEoQDOU.js` | 723758 | 只有精确线程持有 owner role 才响应发现 |

16:55:52，在已运行的 Mini 应用中执行一次正常导航：

```sh
open -a /Applications/ChatGPT.app \
  'codex://threads/01a03f11-382b-7230-a517-0f7b3400e630?hostId=local'
```

这不是 Daemon 新起后端或自己 resume 后冒充附着。App 自身正常载入可能调用 `thread/resume`，不能笼统声称整个过程没有 resume。路由未请求发送，但不承诺 App 自身既有 goal/队列永不运行；实际状态和历史需要另验。

## 读取证据

1. 16:55:36，正式状态为 `unknown/unavailable`；16:56:03 原观测变为 `idle/available`，模型 `gpt-6.1-sol`、provider `openai_http`、effort `medium`。
2. 16:56:37，Mini 安装二进制的独立 `--probe --node-id macmini --codex-home /Users/macmini/.codex --desktop-sock /Users/macmini/.codex/ipc/ipc.sock` 同样返回精确目标 `idle/available`。`control=false,catalog=true,desktop=true,terminal=false`；没有把 `sources.desktop=true` 单独当成 owner 证明。
3. 16:57:14，经香港正式 HTTPS `/v1/sessions/macmini/<id>/history` 读取最新3条、较早1条、再次最新3条：精确 ID、来源 `codex-desktop`、稳定 historyContext、无重复页、最新条目恒等，命令列表未变。读取过程不打印正文、cursor 或 context。
4. 16:58:56 全页仅4条公开 user/assistant item、两个原 turn；当前最新 turn 为 `01a1306a-07fe-73c1-b7ea-d5e34ea6ba98`。本轮不往该工作会话投测试 prompt；仅有资格预检不能证明真实发送成功。

文件目录发现的 `loaded=false`、`capabilities=[read]` 不改写成桌面 loaded/send；桌面状态与 `sendAvailability` 是独立来源。

## Mini 用户服务更新

复用已通过本地/双平台 CI、Air 正式验证的 `ef32a2f1eccc8146343a82046ae921f8c30008d8` 候选，`git diff ef32a2f aead4f8 -- daemon` 为空，无需重新实现或在远端构建。Go build info：darwin/arm64、go1.26.4、modified=false。

本机候选、远端临时交付、Mini 稳定二进制 SHA256 一致：

```text
7c6adeb00d6d043b1ebe888abd77275cd3790c29f25a31e209b307f88a9f30d9
```

- 16:59:00 全量只读 PG 审计：21命令（19completed/2failed），无未决命令/claim/pending plan，1个completed计划、1个未领取pending通知。
- 正常停止唯一 Gateway 和 Controller，17:00:01 均 exited0/OOMfalse；PG 和其他容器不动。17:00:04 停后复审，全部业务表摘要恒等。
- Mini 使用候选 `--service install`，完整保留原 node-id、WSS URL、token-file、state-dir、控制/桌面 socket、codex-home、15秒 heartbeat 和实际 `.claude/skills` 根，仅新增 `--desktop-send`。终端选项仍未启用。
- 17:00:35 新 Daemon PID43500。token 字节摘要仅在内存比对且恒等，journal inode未变；state-dir0700、token/journal0600、owner macmini。App仍PID1304且启动时间不变；没有改App transport、重启App或抢占writer。
- 原 Controller 容器 `f445b05d3e83` 于17:00:55恢复，17:01:10恢复原 Gateway `c6f7fd3a45d3`；镜像与容器身份不变，Air Daemon未更新。恢复后第三次全量审计恒等。
- 三服务随后 healthy/restarts0；Gateway新run自检consecutiveErrors0/totalErrorCount0。这是重启后的计数，不抹去此前run曾有一次已恢复的网络错误。
- 17:02:39 独立正式状态断言 `route=desktop-owner,state=ready,validUntil>now` 通过，同一目标owner可用且idle。没有实际发送。

三次切换审计业务摘要：

| 表 | 行数 | MD5 |
| --- | ---: | --- |
| commands（排除input_receipt） | 21 | `3d751606f40ad9c773b01d9942d2b701` |
| messages | 35 | `6664c32116ecc134e66298d7ac0fa489` |
| leader_states | 4 | `c76f3101ef9acac290faa1d3e558663e` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_notifications | 1 | `8b418d890b46446adc71c839da339f0c` |

通知开关未开启，既有pending记录没有删除或领取。没有新增命令，也没有用近50条接口代替全量排空检查。

## 验证脚本问题与边界

首轮75秒HTTPS稳定性脚本把资格字段误写成 `sendAvailability.status`，末尾资格断言失败；公开合同为 `state`。中途真实输出已多次为ready、历史断言未失败。修正测试驱动，不修改产品合同，并重新运行完整验证；结果见下方最终复核。

5秒发现预算与App10秒负响应不是同一含义；本轮已经取得预算内成功，未据此修改产品超时。内部协议/URL随应用版本可能变化，正常导航返回0本身不能证明owner、历史或发送成功。

已删除唯一临时远端目录 `/tmp/super-leader-mini-upgrade.uLSabe`（仅交付二进制副本），稳定安装和本机可重建候选保留；未建备份、未新建/解归档验收Task、未改用户工作会话cwd。后台探针正常退出，仅复用两位协作者做只读研究与审查。

停用新发送能力时按排空流程重装同版，保留所有原参数但去掉 `--desktop-send`；保留token和journal，不回退陈旧数据、不删uncertain。Mini实际发送/精确终态、不同物理机结果接力、真实微信客户端、公司机器及真实CLI验收仍未完成；完整目标保持active。

## 最终复核

17:03:36–17:04:53，修正后的正式HTTPS验收脚本退出0：

```json
{"event":"PASS","at":"2026-10-12T17:04:53.140Z","elapsedMs":77090,"reads":26,"olderItems":1,"qualificationCounts":{"ready":22,"blocked":3},"historyUnchanged":true,"recentCommandsUnchanged":true,"actualSend":false}
```

每次读取都断言精确session ID、`codex-desktop`来源、同一historyContext与全部item恒等；末尾复用第一轮cursor仍取得1条不重叠旧记录。ready样本另验路由和未过期期限；3次blocked未记录reason细分，不猜测其具体原因，也不宣称资格零抖动或长期稳定。17:04:03第四次全量PG审计仍与上表完全一致；不把持续历史读取当成实际发送验收。

仓库仅修改本记录、节点运行手册和完整验收矩阵；`git diff --check`通过，36个本地文档链接全部存在。既有产品代码和测试未修改，已验证候选被原样部署，不将本次文档检查冒充重新运行全部单元测试。
