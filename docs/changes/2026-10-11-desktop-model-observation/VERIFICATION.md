# 原桌面模型观测验收

日期：2026-10-12（Asia/Shanghai）。范围：原桌面模型设置 → Go Daemon → Controller/Leader → Web 展示、搜索及到期更新。本地实现和以下验收完成；远端服务与已安装 Daemon 未更新。不更改 App transport、不启动共享后端、不重启 App、不恢复或发送真实会话。

## 实现与不变约束

- Daemon 对 snapshot、root patch、父对象和叶字段增量只投影四个精确大小写的模型属性。模型优先使用 `latestCollaborationMode.settings.model`，nullish 时才回退 `latestModel`；非法 override 不伪装成已知模型。
- `DesktopObservation` 新增 `model/modelProvider/reasoningEffort`，保留原 source、availability、observedAt。新 snapshot 缺失值清空旧值；断连不刷新旧观测时间。
- 三层拒绝空值、首尾空白/BOM、控制字符、无效 Unicode 和超过 256 UTF-8 bytes 的标识。坏的可选模型字段被省略，不丢弃有效运行状态，不放宽发送资格。
- Controller 与 Web 同一选择契约：优先 45 秒内可用的桌面模型组，否则取有效 native 模型组；不从另一来源填 provider/effort。native 作为“控制接口记录”展示，其时间仅合法 ISO 时保留；全部未知明确标注。
- Leader `list_sessions` 额外返回 `modelView`；原始字段不覆盖。Web 列表、详情、输入框和搜索统一使用派生结果，无后续 SSE 事件也在到期时更新搜索。
- 原 Session 的 model/status/loaded/capabilities/observedAt、发送资格、固定 route 与 journal 规则不变。模型可见不等于取得 writer 或发送能力。

设计契约：[TECH.md](TECH.md)。完整桌面历史 reader 不在本变更中。

## 独立回归与跨层结果

本变更未新增提交，处于原有新架构脏树中；未将整个旧架构迁移 diff 归功于本轮。主任务独立执行验证，不只采用协作任务报告。

| 命令 / 检查 | 结果 |
| --- | --- |
| `pnpm --dir controller test` | 30 files / 349 tests PASS |
| `pnpm --dir controller run typecheck` / `pnpm --dir controller run build` | PASS |
| `pnpm --dir web test` | 11 files / 182 tests PASS |
| `pnpm --dir web run typecheck` / `pnpm --dir web run build` | PASS；产物 `index-BTjjj-6n.js`、`index-C3RKlVA2.css` |
| `go test -race ./... -count=1`（daemon，exact-key 最终修复后） | 8 个有测试包全部 PASS；client 22.990s，codex 13.276s |
| `go vet ./...`（daemon） | PASS |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...`（daemon） | PASS；仅证明交叉编译，不是 Linux 实机验收 |
| `node test-integration.mjs`（最终修复后） | 退出 0，真 PostgreSQL + Controller + Go Daemon + 模拟桌面 IPC 全部 PASS |
| `node --check web/tests/workspace-fixture.mjs` | PASS |
| `gofmt -l`（本轮 Go 文件） / `git diff --check` | 无输出 / PASS |
| Controller/Web 派生规则交叉向量 | 234 个组合序列化结果相同；覆盖空/坏/未来时间、TTL、UTF-8 边界、坏类型、available/unavailable |

Web 新增 38 例。接入 UI 前，定向测试 4 failed / 34 passed，复现旧模型继续显示、桌面模型搜索不到、更新后仍未知；接入后模型/状态/发送三组共 109 tests PASS，随后全套 182 PASS。Controller 新增 39 例。

集成经实际 framed socket 检查：

1. 真 Go snapshot 上报 `fixture-desktop-model / fixture-desktop-provider / high`，原 native model 缺失、loaded=false、status=unknown、capabilities=[read] 保持不变。
2. 原 owner 的模拟 patch 更新为 `fixture-updated-model / medium`，HTTP 状态及 Leader 工具输出 `modelView` 随之变化。
3. 模拟 runtime 变 active 后 busy veto 生效；模型改动不恢复发送资格。原命令保持精确 turn、固定 route 和幂等，一次投递。
4. 既有 PG 双 client CAS、历史 null route、跨节点隔离、技能版本、计划确认、聊天记忆及 Controller 重启只读回查均通过。

Responses API、桌面 owner 和会话正文均为合成数据。集成不读取真实微信/模型凭证，不向真实会话发送。

## 独立审查发现及修复

按 Agent 编排规范复用已有两个协作任务，不新建 Task；Daemon 与 Controller/Web 写入范围分离，另做只读评审。

- 主任务发现 Go `strings.TrimSpace` 不去除首尾 U+FEFF，而 JavaScript `trim` 会去除。补首尾拒绝及中间保留的测试，三层规则对齐。
- 独立审查发现 Go struct JSON 解码忽略键名大小写：`{"model":"actual","MODEL":"other"}` 会误取 other，而原客户端精确属性为 actual。先补红灯，再改为 exact raw-map 提取模型字段；身份/状态/发送协议未扩改。
- 最终复核 18 项 snapshot/root 正反例及 6 项父子 patch PASS，原唯一 P2 关闭，最终 findings=[]。

## 真实桌面只读核查

主任务执行：

```sh
cd daemon
LIVE_CODEX_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=b3b881ff-1039-58a6-b55f-d74a65602646 \
go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyModelObservation$' -count=1 -v
```

输出：

```text
readonly model observation: model="gpt-6-astra" provider="openai_http" effort="ultra" status="active"
--- PASS: TestLiveCodexDesktopReadonlyModelObservation (0.68s)
PASS
```

此 opt-in 测试先精确 discovery → 固定 owner `read-model-settings` → 关闭连接，再订阅精确同会话 snapshot；核对相同 owner 和三个字段完全一致。未执行 preflight、历史全量加载、resume 或 turn-start。默认无两个显式环境变量时跳过。没有输出聊天正文；没有为获取 patch 而更改用户模型。这是两个只读协议视图的交叉核对，不是对全部会话或部署状态的证明。

## 运行页面验证

按运行时验收要求，用 `ego-browser` 驱动已构建 Web，而不以 DOM 单元测试代替页面。复用 `web/tests/workspace-fixture.mjs` 并新增合成模型场景，loopback 随机端口 `64436`，TaskSpace 35。无生产连接，fixture 的消息发送接口始终拒绝。

| 操作 | 页面观测 |
| --- | --- |
| POST `/fixture/model?mode=fresh`，点击首条会话、打开详情 | 列表/详情/composer 显示 gpt-6-astra；详情 desktop-provider / ultra / 桌面会话设置及时间；原控制接口仍未加载，发送禁用 |
| POST `mode=updated` | SSE 后三处改为 gpt-6.1-sol / high，不刷新页面 |
| 搜索 desktop-provider | 只匹配 1 条目标会话 |
| POST `mode=expiring`，不再广播 | 约 5 秒后自动改为 native-recorded-model / native-provider / low，来源为控制接口记录；原搜索命中 1→0 |
| POST `mode=invalid` / `mode=unavailable` | 坏模型/失联时整组回退到 native，不混入桌面 provider/effort，发送保持禁用 |
| POST `mode=empty` | 模型、Provider、推理强度、来源、时间全部显示未报告 |
| 手机宽度 375×812 | scrollWidth=375，无横向溢出；详情面板 x=55、width=300、bottom=685，全部新字段可读 |
| 点击退出登录 | 会话列表/历史 DOM 清空，localStorage+sessionStorage=0 |

最终 fixture metrics：`{"latest":80,"older":0,"statuses":0,"sends":0}`。本轮只读模型验收没有触发消息发送，也没有把合成历史当成真实桌面历史证据。

已实际查看两张截图，确认模型来源与时间可读：

- [桌面 1200×668](model-desktop.png)
- [手机宽度 375×812](model-mobile.png)

截图均为合成数据；手机宽度模拟不替代微信内置浏览器/真实软键盘验收。Ego Lite 提示可更新，本轮没有升级或修改浏览器配置。

## 清理、未证明项与回退

- 页面退出后 POST `/fixture/stop` 正常关闭服务，进程退出 0；TaskSpace 35 `finish({keep:[]})` 完成。只保留可复核截图与可复用 fixture，无一次性脚本或备份。
- 集成 finally 清理自身临时容器、连接、子进程及目录；复查没有 `sld-*` 或 `super-leader-daemon-test-*` 临时目录。Docker 仅见此前已有的 `vibe-quant-app-1`、`super-leader-postgres-1`，无本轮测试容器残留。
- 两个协作任务均完成；真实验收会话没有创建、恢复、发送或归档，原 fixture journal 保留。
- 没有线上变更需要回滚。部署尚待确认，不能把本地验收写成远端已上线；未来若撤销本功能，只撤模型投影/展示，不清持久数据、不回退旧 Python 架构。
- 桌面完整历史分页、demomini/公司机器、独立 CLI/Claude/Grok 原进程接入、长时稳定性和微信手机端最终验收仍未完成，整体目标不标记完成。
- 内部 IPC 版本依赖仍存在。模型观测没有解决 snapshot 无 nonce、发送预检非原子或用户在 App 同时输入的竞争；不得从本轮只读结果推导这些保证。

经验建议：后续涉及 JS→Go 私有协议投影时，把键名精确匹配与 Unicode 边界加入契约和评审检查；本轮未修改全局规则或技能文件。
