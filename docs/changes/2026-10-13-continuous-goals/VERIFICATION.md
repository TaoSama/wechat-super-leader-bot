# 持续目标增量验收

日期：2026-10-13（Asia/Shanghai）；现场机器为 macOS 节点 A。设计合同见 [TECH.md](TECH.md)。本记录分开描述开发验证与正式验收，不把模拟微信当手机入站。

## 本轮交付

- Controller 新增独立持续目标合同、聊天预览/精确确认/查询/取消、纯模型决策及后台调度器；不把旧四步计划扩容冒充动态编排。
- 独立 PostgreSQL `leader_goals`，不可变授权、决策 lease、精确证据摘要、永久发送 claim、聊天级目标/固定计划互斥和跨进程 CAS。
- Web 严格 HTTP/SSE 合同与持续目标卡：目标→原因/预算→展开条件与动作→准确原会话。无新增浏览器确认/取消管理权限。
- 持续目标增量沿用原 Daemon、CommandService 和原桌面 owner，无专属 Daemon/Gateway 改动；最终发布合并了独立的历史读取修复并更新 节点 A Daemon。不改 App transport 或已有会话目录。

## 开发验证

| 命令/通道 | 结果 |
| --- | --- |
| `node verify.mjs --suite unit` | 最终实现 PASS，13 checks；Controller/Web/Gateway/工具测试及构建、Go race/vet/两平台构建 |
| `node verify.mjs --suite integration` | PASS，6 checks；真实临时 PostgreSQL、模拟模型 HTTP、WS/Go 原会话协议、Cookie/SSE/登录整链 |
| `pnpm --dir controller exec vitest run tests/goal-model.test.ts tests/console-goals.test.ts tests/execution-store.test.ts tests/execution-confirmation.test.ts tests/notification-store.test.ts` | 87/87 PASS |
| 两位既有协作者独立审查 | 授权入口、存储/调度器、纯模型、公开投影、JSONB 顺序、整链断言与清理已复核 |
| `git diff --check` | PASS |

整链明确证明：预览零派发；一次确认后无新用户消息，第一轮结果 A/B 导出不同第二任务；accepted 等待；精确结果支撑逐条条件；忙碌不消耗发送 claim；重启保留冻结输入、不重复第一任务；unknown 不重发；取消不停止原任务但禁止后继；真实动作/模型预算耗尽停止；Cookie 不能调用通用管理写接口；HTTP 与 SSE 同白名单投影且不泄露正文/lease/claim。

PG 验证包含双客户端并发确认、决策 CAS、永久 claim、目标/固定计划事务互斥、通过 `pg_blocking_pids` 独立证明行锁后到期/撤权、重连。最终追加单聊天白名单先过滤再 LIMIT 的精确断言，并将存储层新增 claim 限制为原动作 waiting；这两处在第一轮全链加载后完成，最终 unit 和随后固定提交的双平台 CI 已覆盖完整增量。

## 真实浏览器（合成业务）

运行 `node web/tests/workspace-fixture.mjs`，真实浏览器访问 `http://127.0.0.1:51825`：

- 1440×1000 桌面查看目标卡与展开层次；SSE active→completed 后 `details.open=true`，展开态不丢。
- 点击第二动作跳到精确 `demoair/fixture-review`，标题及模型 `gpt-6-astra` 对应正确。
- 390×844 手机：`innerWidth=390` 且 `document.scrollWidth=390`，无横向溢出。
- blocked 显示需要处理/不自动重发；证据不足的 completed 显示“完成依据待核查”，不错误显示条件满足。
- fixture 记录 `sends=0, terminalInputWrites=0`。TaskSpace 57 已关闭，fixture 经 `/fixture/stop` 正常退出0。

截图：[桌面](screenshots/desktop.png)、[手机](screenshots/mobile.png)、[手机卡片](screenshots/mobile-card.png)。最后一张为卡片状态，不冒充展开截图。前端沿用既有简洁视觉分层，浏览器验收受技能要求约束；没有升级浏览器工具或改环境。

## 发现与修复

1. 模型已提出目标但随后 abort/预览失败时，恢复前一 pendingGoal，防止留下未展示的新授权；5项入口回归随 Controller 全测通过。
2. 旧终端计划确认在特殊分支可能绕过 active/blocked 目标占槽；入口和最终发送 guard 都复查互斥。
3. 正常调度器已拦截 orphan 命令，内部 Store CAS 原可补 claim 将 uncertain 转回 pending；存储层现在要求最后动作 waiting，pending/completed orphan 两项回归均拒绝且不改原命令。
4. unknown 整链初稿断开后立即重连，generation 保护正确跳过旧连接 cleanup，不能据此假设已持久 uncertain；fixture 改为先独立等待原命令 uncertain 再重连。统一全链通过，不改产品连接语义。
5. 旧 PG mocks 尚未认识新增事务 advisory lock/目标占槽 SQL；更新 mocks 还原真实事务，不删除生产锁迎合测试。
6. 浏览器选择器“需要处理”匹配多处，读取当前 snapshot 后改为精确观察；不是产品故障。

## 正式部署前审计

18:24:17 和18:31:24 UTC，远端全量只读审计：21命令（19 completed、2 failed）、无未决命令/聊天claim/pending plan/pending goal；1个 completed 固定计划，原唯一通知为同 attempt 的 uncertain。新增目标表尚不存在。复核使用 [audit.sql](audit.sql)，不依赖近50条状态接口排空，不输出聊天正文或凭证。

| 旧业务表 | 行数 | MD5 |
| --- | ---: | --- |
| commands（排除 input_receipt） | 21 | `3d751606f40ad9c773b01d9942d2b701` |
| messages | 35 | `6664c32116ecc134e66298d7ac0fa489` |
| leader_states | 4 | `c76f3101ef9acac290faa1d3e558663e` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_notifications | 1 | `c6d5deec003490f2d6dc72b4ac634bbf` |

固定提交 `e18856e` 的 [CI 38291658905](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38291658905) 已最终通过 Ubuntu 全量和 macOS unit。Ubuntu 首次在 `docker compose version` 返回 255，失败任务重跑后成功；没有独立证据将首次失败武断归为环境问题。该提交的镜像只预载、未切换；最终合并 UI/历史修复，使用通过 [CI 38295230409](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38295230409) 的 `08e260a` 正式发布。

## 正式发布与真实闭环边界

远端 Controller/Web 的 `08e260a` 已运行，节点 A Daemon 同版；Gateway、PG 保留原容器和状态。发布脚本曾保护退出且丢失确切失败诊断，独立配置/业务/身份核验通过后只恢复原 Gateway，没有回滚或重建业务。具体镜像/binary hash、诊断缺口与恢复验证见 [发布记录](../2026-10-13-history-source/VERIFICATION.md)。

本轮复用专用会话 `c0863a5b-311c-5ab9-997b-be2e24fffb18`，未新建会话或后端。正常取消归档并精确导航后，桌面状态可以变为 idle，但发送资格从 checking 变为 unavailable；native 为 notLoaded/loaded=false。没有根据空闲推断可发送。

仅执行一次明确的服务端模拟微信入站预览（messageId `goal_release_08e260a_preview`），真实模型提出 `propose_goal` 后被目标资格检查拒绝。响应说明目标不可发送，没有保存可确认 UUID 或 pendingGoal，也没有派发。验证脚本以 `No confirmable preview` 退出 1；这是未达到验收条件，不作为临时接口故障盲目重试。未执行后续确认/观察阶段。专用会话已重新归档，返回主会话。

2026-10-12 19:25:43 UTC 使用 `audit.sql` 再核验：commands 21 条、digest 仍 `3d751606f40ad9c773b01d9942d2b701`；leader_goals 0；所有聊天无 claim/pending/pendingGoal。固定计划及旧 uncertain 通知摘要不变，未补发。messages 由恢复前 36 增至 37，leader_states 修订随本次预览合法变化，不能再用恢复前两表摘要宣称完全未变。

结论：持续目标已部署，合成闭环通过；真实原会话持续闭环仍未通过，阻塞在发送资格。没有绕过资格、切换后端或抢占 writer。真实微信索取控制台链接已在独立请求中验证，不代表目标控制闭环已验收。

## 保留边界与回退

持续目标终态主动微信通知尚未实现，暂用查询/Web；旧固定计划通知不等于目标通知。CLI `input-written` 没有精确完成，不能进入目标闭环。跨物理机闭环、真实手机微信目标控制/内置浏览器、公司机器和长期稳定性仍需独立证据。

目标文字/约束不是原会话的权限沙箱。超预算、裁剪/缺失/矛盾证据、失效资格和未知回执保持可见；不扩大权限或新建请求绕过。只有原生精确完成也不足以证明业务目标，UI明确为模型判断。

回退前先正常排空并审计目标、聊天预览/claim和命令，保留数据库/授权/通知/checkpoint/journal；不得回退到不理解尚未结束目标的旧调度器。没有未结束授权时可使用保留的原 Controller 镜像恢复，新增表保留、不删数据；不重建微信基线、不补发 unknown。
