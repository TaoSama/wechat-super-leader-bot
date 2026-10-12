# 验证记录

日期：2026-10-13；本机为 macOS 节点 A。产品提交 `08e260acc33287e18ab5a3b920614cdd2864fc53` 已上线；以下分开记录开发验证、正式只读验收及发布异常。

## 开发与只读现场

| 验证 | 结果 |
| --- | --- |
| `node verify.mjs --suite unit` | PASS 13 checks：三组件测试与构建、Go race/vet/两平台构建 |
| `node verify.mjs --suite integration` | PASS 6 checks：真实临时 PG、HTTP/WS/Go、目标闭环及 Cookie 登录；合成业务 |
| `pnpm --dir controller exec vitest run tests/session-history-hub.test.ts tests/session-workspace-http.test.ts` | 84 tests PASS |
| Web 历史/工作台定点测试 | 修复滚动边界后 55 tests PASS，build PASS |
| `pnpm --dir web test` | 最后修改后 24 files / 446 tests PASS |
| `git diff --check` | PASS |

已有 control socket 只读测试（精确两个目标，不输出正文）：limit=1 首/次页成功；默认 30 请求分别返回 17/12 条公开条目并有更早游标，耗时约 0.05/0.02 秒。原生记录过滤后空页仍可有游标，不能把空页等同历史结束。没有发送、resume 或新后端；没有证明所有更早页或任意单项都低于 8 MiB。

全量测试不连接正式业务；显式 live test 开关仅用于上述只读现场检查。桌面根目标出现 52,405,498 字节帧声明，超限正文没有被读取；另一目标首帧超时，无大小证据。

## 评审修复

已有 nextCursor 后，最新页返回 413 时原实现仍可被近顶滚动触发自动旧页请求。新增回归在修复前失败（预期 2 次，实际 3 次）；现在只拦截自动滚动，手动重试保留原 context。换源取消、迟到旧页、Controller/API 响应绑定和 Terminal 拒绝均有测试。

## 浏览器筛选验收

真实浏览器使用 loopback 合成 fixture：1440×1000 下机器筛选 118×32、状态 156×32，选中前后尺寸不变，键盘焦点 3px；375×812 及 844×390 粗指针下 44px 高，无横向溢出。发送计数和终端输入计数均为 0。按设计技能保留触控尺寸与焦点，仅收紧局部密度。

分页入口真实交互：默认 413 → 点击显式分页 → 30 条消息出现；向上读取后保留 90 条，追加最新记录后变为 91 条，旧页仍在，阅读锚点位移 0px。375px 手机 `scrollWidth=375`；恢复自动来源清空原阅读窗口并重新显示 413，不混入分页内容。超限后两次 metrics 均为 latest=55、older=2，无自动重试；sends=0、terminalInputWrites=0。fixture 已通过 `/fixture/stop` 正常关闭。

浏览器点击旧页按钮时，定位器自动滚动已触发两次旧页加载，随后按钮移出视口导致点击超时；重新观察确认 90 条记录后不盲目重试，以旧页保留与增量更新断言验收。不是一次失败点击就宣称成功。

截图仅含合成业务：[桌面筛选](screenshots/filters-desktop.png)、[手机筛选](screenshots/filters-mobile.png)、[桌面分页](screenshots/history-paged-desktop.png)、[手机分页](screenshots/history-paged-mobile.png)、[手机错误入口](screenshots/history-error-mobile.png)。

## 微信与公开检查

用户本次真实微信请求已关联到回复中的准确登录链接：2026-10-12 18:35:24 UTC 入站，链接于 18:35:34 UTC 兑换成功；未补发或模拟该请求。凭证仅内存提取后 hash 关联，未输出 token、聊天 ID 或正文。该证据不识别用户用了哪种浏览器。

公开前使用已核验官方校验和的 gitleaks v8.30.1 执行 `gitleaks git --log-opts=--all --redact=100 --ignore-gitleaks-allow --no-banner --report-format json --report-path <临时报告> <项目目录>`。覆盖产品提交在内的 49 commits / 4.29 MB，仅一个已核实的测试假值命中（`daemon/pkg/client/send_identity_test.go:40`）；未发现运行时密钥/数据库被跟踪，不把扫描视为无泄漏保证。旧验收截图包含真实其他会话标题及预览，仓库暂保持私有，等待用户选择移除历史截图或明确保留后公开。不擅自改写历史。

## 正式发布与核验

固定产品提交的 [CI 38295230409](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38295230409) 已通过 Ubuntu 全量与 macOS unit。镜像在本机构建为 linux/amd64，远端只加载产物、不构建；节点 A 使用固定 Git archive 构建的 arm64 Daemon。

| 产物 | 已运行版本 / SHA256 |
| --- | --- |
| Controller/Web | `08e260a` / `12bbda64a7ed28d75b12e71fdf195daefd21e95ffe5abefdf62d24988577d51d` |
| 节点 A Daemon | `08e260a` / `fe7fe2c9876834ebb1b2a502940c65c63bf8e71084f034996e1475e13d871a31` |
| Gateway | 保留原容器，`3a750e7` / `4eda73ea285e741727f8ae703cf3ecd0316838034a84a81c86ce145699d5f426` |
| 节点 B Daemon | 保持 `ef32a2f`，本轮未改服务或 App |

节点 A 通过标准服务安装入口完整重放既有参数，token hash、journal inode、node-id、URL、socket、技能和桌面发送配置不变；旧 PID 正常退出，新 PID 33291 持有原 journal。未创建备份、隔离 worker 或第二个 App 后端。

正式 HTTPS 只读接口对两个 节点 A 长会话分别执行首/旧/最新页：主会话返回 14/15/14 条，用时合计 2889ms；另一目标返回 12/1/12 条，用时合计 751ms。来源、context、会话绑定均正确，翻页无重复；已有桌面 context 强指定另一来源返回 409。仅验证这些有限页面，不代表每项/每页永远低于 8 MiB，也不恢复超限桌面帧的观测与发送资格。未输出真实历史正文。

正式浏览器加载 `/assets/index-D0G0MZ4s.js`：一次性登录兑换成功，地址无 hash/query；目标默认历史超时后点击“使用分页历史接口”，显示 12 条记录及来源提示、无错误。375px 视口 `scrollWidth=375`；桌面机器筛选 118×32，触控高 44px。正常退出登录，专用浏览器 TaskSpace 已关闭；真实会话截图未加入仓库。首个浏览器子进程受临时辅助脚本路径访问限制而失败，改由主进程取链接、经标准输入仅在内存传递后通过，未修改系统权限。

## 发布保护退出与恢复

成对发布在正常停止原 Gateway/Controller、安装 节点 A 并启动候选后报告 `cutover-committed-recovery-required` / `paired-release-not-completed`。候选保持健康，Gateway 保持停止，没有自动回滚。原 driver 丢弃 stderr，无法追回触发保护退出的确切原因；不得将此归因于已证明的运行时差异。后续检查旧/新 image 默认配置（除版本标签）及 commands 完整字段摘要均无差异。

恢复前使用独立只读校验核对候选 image/non-root/health、原 Gateway/PG 容器身份、3 个 Compose 文件 SHA、完整环境与保留 Compose/image defaults、只读根目录/资源限制/权限/日志/tmpfs/端口/网络/挂载、全部业务摘要及 checkpoint。第一次仅校验通过；第二次再次校验后只启动原 Gateway，未回滚、未重建或清除数据。该核验不能补回原脚本丢失的运行时快照与失败原因。临时 driver 随后补有界脱敏错误分类，17 项握手、13 项安装 mock 与 33 项 Python 测试通过，未为验证诊断再次操作生产。

2026-10-12 19:25:43 UTC 最终审计：Controller、原 Gateway、原 PG 均 running/healthy，节点 A 服务 PID/hash 与上表一致。使用 [只读 audit.sql](../2026-10-13-continuous-goals/audit.sql) 验证 commands 仍为 21（19 completed、2 failed），无未决命令、聊天 claim/pending plan/pending goal，目标表 0 行；唯一旧通知的 attempt/status/digest 不变，仍 uncertain、未补发。持续目标预览检查合法增加 1 条 message（总 37）及聊天状态修订，不误称所有表一直未变；该检查未派发，详见 [持续目标现场边界](../2026-10-13-continuous-goals/VERIFICATION.md)。

回退需同时考虑 Controller/节点 A 数据合同；先正常排空、保留数据库和 journal，不能让旧 Daemon 忽略显式来源后冒充分页成功。当前 Controller 会拒绝错误来源。保留原远端镜像，不执行全局镜像清理，不删除运行时状态。
