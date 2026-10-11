# 有序技能组合发布与真实原会话验收

本地日期 2026-10-12；本文运行时间均为 2026-10-11 UTC。完整项目仍未完成：Mini/公司机器、其他 CLI 主动控制、动态编排与真实微信手机端仍缺验收。本轮没有改 App transport、启动新 app-server 或重启 Codex App。

## 发布身份与前检

- 固定源码 `a4ef93ca95bb3a1aac3ee955c40a7db7a4193181`，包含有序组合提交 `e7dbf71`。此前本地单元、race/vet、构建、真实临时 PG 整链结果见 [组合开发验收](../2026-10-12-ordered-skills/VERIFICATION.md)。
- Air 为 Mac17,3 / darwin arm64，Docker VM 为 linux/aarch64、4 CPU、约 8 GiB；香港约 2 GiB、无 swap，本轮不在香港构建。
- 官方固定 buildx v0.38.0 darwin-arm64 仅下载到临时目录，SHA256 与下载的 checksums-signed.txt 对应条目一致：`85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344`。未安装系统插件或修改 Docker 配置。
- `git archive a4ef93c | <temporary-buildx> build --platform linux/amd64 -f Dockerfile.controller --label org.opencontainers.image.revision=<完整提交> -t super-leader-controller:a4ef93c --load -` 退出 0；构建上下文不含 `.runtime`。
- 镜像 ID：`sha256:59d8da29f8ff97a8b655d87a4cf5e5a3a76b6157bc42bcd7f881426ca10c1e14`。`docker save` 经 SSH 直接流式 `docker load`，没有 tar 或数据库备份；两机 ID、架构、完整镜像 Config 和 RootFS 层逐项相同。
- 两机网络禁用的候选容器烟测均通过：Node v24.21.0、x64、UID 1000、最大技能数 4、两/四技能可校验；Air 另核对重复引用拒绝和 Web index 存在。烟测容器已自动删除。
- Go 候选 `go build -o bin/super-leader-daemon .` 与 `go version -m` 通过，darwin/arm64、相同完整 revision、`vcs.modified=false`。二进制 SHA256：`2ee20a020c1e5e8c1cc0dce912097ee1e9bee9df782d2e0ab0a93ef63f539a4e`。

## 排空与切换

21:25:51 全量只读 PG 检查：15 completed、2 failed，无其他命令、有效 claim/待确认、active execution 或未决通知。不能用截断的状态接口代替此检查。

| UTC | 动作与证据 |
| --- | --- |
| 21:28:35 | 再次全量只读审计通过 |
| 21:28:36.280 | 唯一 Gateway `docker stop --timeout -1` 正常退出 0；随后再次审计通过 |
| 21:28:36.720 | Controller 同方式正常退出 0；冻结写入口后第三次审计通过 |
| 21:29 前后 | Air 用原 node-id、URL、token-file、state-dir、两个 socket、codex-home、desktop-send、heartbeat 15 和四个 skill-root 安装候选；PID 17909，原 token 内容、journal inode 和 0600 权限不变，安装后 SHA256/revision 相同 |
| 21:29:33.341 | Controller 以 `up -d --no-deps --no-build --pull never controller` 切换；实际容器 image ID 与已核对候选相同 |
| 21:29:51 | Air 在线、17 个会话、8 个桌面发送资格 ready、83 个技能；旧命令精确 turn 和输出仍相同 |
| 21:30:01.929 | 验证停止期间 checkpoint SHA256 未变后，恢复原 Gateway 容器/镜像，不重建基线 |

PostgreSQL 始终为同一运行实例，StartedAt 仍为 `2026-10-11T05:56:45.930299545Z`。恢复后三个服务 healthy、restart=0；Gateway 健康检查 consecutiveErrors/totalErrorCount 均为 0。空轮询健康不是微信端到端通过。

## 真实有序组合

明确恢复并复用专用会话 `01a12a91-5777-75e0-8df3-4ee968565997`，cwd 为项目目录，不创建额外测试会话。原 App 打开后精确资格为 desktop-owner/ready；原控制事实仍为 loaded=false/notLoaded，桌面模型为 gpt-6.1-sol/openai_http/low。

只发送一次管理 HTTP 命令，限定读取技能与计算 SHA256，不允许初始化、构建、安装、修改文件、外部消息或新建其他任务。顺序为 ai-scaffold-init、ai-agent-orchestration，特意不是目录排序。

- requestId：`release_ordered_skills_a4ef93c_01`
- commandId：`cmd_cf6d3b99-b9cc-4585-96f4-9690a760ea89`
- 精确 native turn：`01a12ce0-044c-7d73-893b-9a35ed8f9d5f`
- 回执 completed；原 App 独立 `read_thread` 同 turn completed，11322 ms。
- 原 App 工具记录依次完整 `cat` 和 `shasum -a 256` 两份文件，均退出 0；完整工具输出中的实际 SHA256 与主控独立计算及目录记录相同。
- 最终输出：

```text
RELEASE_ORDERED_SKILLS_VERIFIED_20261012
ai-scaffold-init c6e840cb929d0a06c378ef62bbf8265dffa5353916c7c25103199ddd49290838
ai-agent-orchestration efe6023b6d1117581a24f150c75d64fe29cbc28f70cd4ce988ee6f24aa1d30a3
```

相同 requestId/原始 payload 返回同 command/turn/顺序/输出；同 requestId 将技能反序返回 HTTP 409。随后独立原 App 检查最新 turn 未变。21:34:08 全量 PG 已为 16 completed、2 failed，仍无在途；精确 requestId 仅 1 行，completed、精确 turn、技能引用数 2 均通过。

这是管理 HTTP → 真实 Daemon → 原 App/模型的组合验收，不是自然语言微信入站或手机端验收。SHA256 仅绑定 SKILL.md，不冻结依赖目录，不能把此次只读核验扩大成复杂技能业务执行保证。

## 发布后发现的历史读取问题

发送、精确完成回执和重复请求检查已通过，但后续无 historyContext 的首次历史 GET 返回 HTTP 409。21:32:07 只读重试仍为 `history_context_expired`；没有重发任务。

独立命令也复现首次读取失败：

```sh
LIVE_CODEX_DESKTOP_SOCKET=/Users/luwentao/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=01a12a91-5777-75e0-8df3-4ee968565997 \
LIVE_CODEX_DESKTOP_HISTORY=1 \
go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyHistory$' -count=1 -v
```

结果为 `readonly history: History context expired`，退出 1。该独立通道将问题缩小到桌面历史读取器，不是单纯 HTTP/路由 token。

显式 opt-in 的只读事件诊断进一步证明：initialize 成功后，discovery 阶段先收到定向 `thread-stream-following-changed` 广播；此时 owner 尚未确认、订阅尚未建立，却被原 reader 判为上下文失效。诊断只输出白名单标量，不记录正文、身份或凭据。

最小修复：匹配 response 仍优先处理，未订阅广播仅消耗原有噪声预算，不建立历史、不改变请求/owner/deadline。订阅后的 owner、target、版本、revision、patch base、generation 和完整历史前缀校验不放宽；32 MiB 入站、128 噪声与原超时不变。

回归覆盖 discovery/settings × state/following-false/following-true，前 128 条噪声可跳过、第 129 条失败；已订阅后的错误 owner 和 false-follow 仍拒绝，模拟 socket 整链首次读取只返回正式订阅后的记录。初次整链 fixture 误用了只接受 `observer-client` 的 helper，全量 unit 因此 exit 1；改为严格核对 `history-client` 的真实协议，不修改生产协议规避测试。

修正后定向回归全部通过（0.642s）。相同原 App、相同已完成 turn 的只读 live test 通过：first=3 / older=3 / latest=3，来源 codex-desktop、固定 generation。独立诊断再验证了因果链：同一 discovery 广播 noise=1/error=none → owner response → settings → version=11 snapshot → complete=true/items=16 → 正常 unfollow/close，退出 0（0.262s）。没有再次发送任务。

主控完整复验：`node verify.mjs --suite unit` PASS 12 checks / exit 0（含全包 race/vet、macOS/Linux 构建，codex race 30.503s）；`node verify.mjs --suite integration` PASS 6 checks / exit 0（真实临时 PG、真实 Go 模拟 owner、HTTP/WS、计划/通知和一次性登录）。临时服务与容器正常回收。独立只读评审无阻断问题。

### 正式历史修复更新

干净提交 `e1a6408fc65c53c78d00c7a982b67819bcf8351f` 构建 darwin/arm64 Daemon，`vcs.modified=false`；安装后二进制 SHA256 为 `0f6c10a16490d30b9981731daf1979f5bf15c535e819ea317546c1e815dadf24`，PID 29300。原 token 内容、journal inode 和两个文件的 0600 权限保持不变。

21:46:22 再次全量 PG 排空检查；Gateway 于 21:46:38.997 正常退出 0，其后审计仍通过；Controller 于 21:46:39.566 正常退出 0，冻结写入口后的第三次审计通过。全部为 16 completed、2 failed，无在途、有效 claim/pending、active execution 或未决通知。安装保留完整原参数，不更换绑定或创建空 journal。

21:47:17.838 恢复原 Controller 容器及 `a4ef93c` 镜像，不重新构建。首次 readiness 断言未通过；定点只读复查于 21:47:58 确认 Air connected、83 技能、原命令精确 turn/output 不变。历史验收脚本另有一次字段名误用 `skillRefs`，对照源码及实际响应键确认为 `skills` 后仅修验收断言，未改 API 或重发任务。

21:48:26 正式 HTTP 只读验收通过：首次 GET 200，first=3 / older=3 / latest=3，source=codex-desktop；固定 historyContext、旧页无重叠。明确按 `turnId`、`kind=assistant`、`type=agentMessage` 和完整 text 匹配上述三行输出，不能以用户 prompt 含成功标记冒充结果。原 command 仍 completed、同 turn、两技能。原 App 独立 read_thread 仍为同一最新 turn/completed，无新增 turn。

确认停止期间微信 checkpoint SHA256 仍为 `f5c92cd16d99b7692cdc02c81300c5348269865637f0f390cfd50fa809a6e6f6` 后，于 21:48:28.380 恢复原 Gateway。21:49:23 最终全量 PG 再核：16 completed、2 failed、无未决项，精确 requestId 仅 1 行且 exact receipt=true。三服务 healthy/restart=0，Gateway errors=0；PostgreSQL StartedAt 仍为 05:56:45.930，没有重启。没有操作 Codex App 生命周期。

## 回退边界

此次已真实保存两技能命令，旧 Controller 的 `max(1)` 读取校验连终态记录也拒绝。不能直接退回旧镜像、删除历史、清空 journal 或恢复陈旧数据库；应保留现数据合同进行修复。运维切换示例已补 `--no-deps`，避免触碰 PG。

专用验收会话核对 idle/completed 后已归档，并返回主 Task；没有新增测试会话。临时 buildx 目录已移到废纸篓，原路径不存在，可恢复；正式镜像、服务和运行数据保留。统一验证创建的临时容器已回收，本机只保留原有 PostgreSQL 容器。上述提交仅在本地，未推送。
