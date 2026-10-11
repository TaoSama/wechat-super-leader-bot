# 已确认计划的结果传递验收

日期：2026-10-12（Asia/Shanghai）。基线 `5f3f956`，仅本地源码，未 push、部署或向真实会话/微信发送。

## 范围

确认预览明确结果来源后，把同计划的精确完成输出作为不可信资料附在后继原任务后。默认依赖不共享输出；目标、技能、路线和原任务不变。来源快照与唯一领取同时持久化，重启只核查原命令，不重新采样或发送。详见 [TECH.md](TECH.md)。

PASS：本地真实 Controller/临时 PostgreSQL/合成节点整链与独立浏览器界面均通过；这不是正式环境或真实模型、微信验收。

## 首次失败与根因

首次 `node verify.mjs --suite integration` 在实际临时 PostgreSQL/Controller/两节点 WS 中通过首项裁剪传递，但第二步返回空结果后报：

```text
Timed out: Result step 3 accepted
synthetic-integration: failed (exit 1)
```

1. PostgreSQL 的 `output || undefined` 把已记录 `""` 映射为缺失；插入也使用 `|| null`。改为 nullish 判定，新增内存/PG 两存储的插入、查询、去重回归。
2. Wire schema 原先把省略的 output 默认成 `""`。移除默认值；Hub 回执等待者也不再补空。
3. 完成回执省略 output 时，状态转移原先继承 accepted 输出。完成阶段现在只保留本次提供的输出；两存储及 WS/Hub 回归覆盖三态：缺失、明确空、有文本。
4. Go 回执、journal 重放及原生 turn 解析保留这一差别；缺失/null/非法 items 或 assistant text 返回不可用，不能仅因为状态 completed 就转为空结果。明确空 items/text 仍可产生空结果。
5. 已 ACK 的 journal 正文已裁除，原始记录中的空占位不是空结果证明。读取时按 Acknowledged 不变量归一为无正文，不迁移/回写记录。原始 JSON fixture 重启重复 Execute 保留命令身份与状态、适配器读取次数为 0；Lookup/Begin 不复活输出，原持久字节不变。首次测试还暴露非空 presence 标记的对象等值问题，已将其规范化为“非空自身证明存在、空串用显式位”，序列化往返通过。

独立审查另发现文档“全 Web 不暴露实际输入”与既有命令审计入口冲突。合同已明确：计划 DTO/微信固定计划摘要不展示附件正文；认证命令详情仍展示已记录实际请求（含附件），不等于已发送。模型的既有同聊天结果查询也仍可读正文。Console Cookie 是工作台读权限，并非按微信聊天隔离。未新增正文隐藏层或扩大权限。

## 真实接口验证

`test-plan-result-handoff.mjs` 经统一验证入口接入真实 Controller HTTP/WS、生产 Scheduler/CommandService 和临时 PostgreSQL；仅模型工具选择、两节点与完成回执使用合成目标，不直接调用 Scheduler 代替运行应用。

实际通过的观测：

- 未确认零命令，预览列明来源顺序与裁剪；错误节点、错误 turn、accepted 不解锁。
- 首步长 Unicode/转义文本及恶意指令样本被作为 JSON 资料，不新增目标；仅证明 Controller 没扩大目标，不证明真实模型抵抗提示注入。
- 冻结文本、命令/turn、完整已记录输出 hash、长度和裁剪一致；修改快照被 CAS 拒绝。
- 重新打开 PG 与正常重启 Controller 后快照不变，原命令 uncertain 时只 inspect，不重发。
- 第二步明确空结果可推进第三步，来源顺序 `[2,1]` 保留；重复完成不重复派发。
- accepted 曾有正文，但 completed 缺失 output：正文不继承、来源不领取、后继不发送、计划 failed。
- 真实 Cookie HTTP/SSE 的计划投影一致且仅有来源摘要；认证命令详情如实保留记录的请求。Cookie 仍不能调用通用管理写接口。

关键实际输出：

```text
PASS real PG/HTTP/two-node WS preview zero sends; wrong node/turn blocked; clipped Unicode result frozen with hash; plan HTTP/SSE show only source metadata while authenticated command detail preserves actual request
PASS persisted result snapshot survives Controller restart unchanged, no duplicate send; 3-step chain matches resolved parent prompt; empty output is explicit and source order frozen
PASS completed receipt without output clears earlier acceptance text; never masquerades as empty result or dispatches a successor
[verify] PASS 6 checks (integration); synthetic fixtures only, no production acceptance claimed.
```

## 浏览器观测

用 `node web/tests/workspace-fixture.mjs --port 0` 启动 loopback 合成 API，浏览器空间 40 操作构建后的 Web。这里验证 UI，不声称浏览器连接了真实 CLI 或微信。

- 375×812、812×375、1440×1000 三尺寸，文档宽分别等于视口宽，无横向溢出。
- 原生 details 展开来源命令/turn/hash；两处 summary 点击高度 44px。第二处用键盘 Enter 展开；reduced-motion 模拟下 transition 为 `1e-05s`。
- 同一计划显示未冻结来源、已冻结裁剪结果和明确空结果；第 4 步来源顺序 `[2,1]`，不是按编号重新排序。
- 点击步骤 2 跳到 `demoair / fixture-review`，详情显示“数据库事务与回执关联复核”和模型 `gpt-6-astra`。
- 返回计划，SSE 更新后时间变为 07:27:50，计划和两个来源 details 仍展开（openDetails=3）。
- 最终 fixture 计数：`latest=7, older=0, contexts=1, planUpdates=2, sends=0, terminalInputWrites=0`。

截图：[手机来源详情](mobile-sources.png)、[桌面完整工作台](desktop-sources.png)。主控均已查看；长 hash 在窄屏换行，详情按需展开，不抢占列表摘要。

## 回归、边界与清理

- 修复后 Controller：48 文件 / 703 测试通过，类型检查通过。
- `node verify.mjs --suite unit`：13 checks PASS；包括 Controller 703、Web 396、Gateway 104、CLI/工具 81 测试，构建及 Go race/vet。主控全量 Go race 中 client 22.484s、codex 30.883s、journal 4.537s、protocol 2.343s；macOS 和 Linux amd64 构建通过，不等于 Linux 实机运行。
- `node verify.mjs --suite integration`：最终 6 checks PASS；含新结果链、原桌面/终端历史与输入、持久计划、合成 Gateway 通知、一次性登录 PG 验证。
- `git diff --check`、根集成脚本语法检查均通过。两位协作者完成交叉审查，主控独立运行上述整链与浏览器；不是只依据单元测试或协作者结论。
- 未验证真实模型结果接力、真实微信入站/内置浏览器、真实终端发送或 Linux 服务运行；没有动态重规划能力。终端 input-written 仍不能参与结果链。
- 无系统配置修改、App 重启、新 app-server、resume、writer 抢占或 Codex 数据库写入。
- 浏览器空间 40 已 finish、无保留页面；自有 UI fixture 经 `/fixture/stop` 正常退出 0。保留两张交付截图，无备份。
- 主控两次整链（包括首次失败）的入口均自然收尾；最终 unit/integration 进程退出 0，临时 PostgreSQL 容器、自建 Controller/Go/socket 由验证入口清理。协作者测试资源由测试清理机制收尾。浏览器提示有 Ego Lite 更新，未擅自升级。
- 两名既有协作者参与实现/审查；过程中一名协作者误创建两个子 Agent，已立即中断，确认未写文件或遗留进程，之后未再调用它们。

正式环境未变，无需生产回退。不要删除 journal/PG 来回退或重新发送；若后续发布需关闭结果传递，停止提出新的 resultFrom 计划，并通过原聊天取消尚未领取的后继。

建议后续全局审查规则加入“空值、缺失、阶段性输出必须跨协议和存储逐层核对”；此建议未写入任何全局规则或技能。
