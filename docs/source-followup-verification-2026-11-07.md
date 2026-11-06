# 后续结果只读查询的规则澄清与验证

本次变更补充用户追问后续结果时的工具选择规则。实际 Controller 工具链、生产请求配置下的模型自主工具选择、历史边界回答和真实授权分类均取得证据。该验证采用平铺 function tools 的 Responses API，不能宣称完整原生 Codex 等价或证明生产历史错误的唯一原因；旧规则在本次成功报告样本中同样答对，不能宣称已证明因果改善。

## 事实与责任边界

11月6日14:14，微信助手已取得原会话 ID，但查询止于08:00定时轮次的 failed 记录。14:17用户明确要求读取原会话后，同一个 `read_session` 工具取得后续报告。独立核对的原会话记录显示，08:34有后续独立轮次的完成报告。

因此，当时的读取能力可用；没有证据表明 `read_session` 被权限拒绝或工具未提供。已定位的指令缺口是：

- 精确 occurrence 规则强调不得用最近消息代替原轮次状态，没有说明用户追问后续结果时应继续读取同一会话。
- “再看看刚才那个”被直接示例为 `follow_up_background_task`，与只读查询规则有歧义。
- `inspect_source_automation` 的描述没有明确其结果不包含同会话后续独立轮次。

这些是本次最小候选修复的依据，不足以证明模型历史决策的唯一原因。图片插话、上下文裁剪等因素未在本次复现或修复。

原08:00失败轮次仍是失败。后续报告、监控任务 completed 和微信投递分别取证，不能互相替代。主控另行核实14:07及14:08两条通知都有发送API接受回执，正文均为原失败轮次的监控报告；不能说完全没有发送回执，也不能称后续成功日报已送达。API接受不代表用户已读。

## 变更

仅调整 `BACKGROUND_INSTRUCTIONS`、内部后台授权分类器的含混示例和源轮次工具的描述：

- 用户指出后来成功或要求重读最终结果时，沿工具已定位的机器、会话调用 `read_session`，继续核查后续正文。
- 保留原失败状态；会话报告不充当原 occurrence、本次派发或微信投递成功的证明。
- 查询已有结果保持只读；明确要求后台继续工作或执行新检查时，才走现有后台追问路径。
- 结果缺失、历史裁剪、读取失败或目标不唯一时，说明证据缺口或澄清目标。

没有修改 daemon 的轮次识别、时间窗、自动监控策略、授权实现、数据库或投递实现。

## 确定性覆盖

`controller/tests/leader/direct-background.test.ts` 新增四种只读路径：后续有报告、空历史、裁剪片段、读取失败。每种都先读 failed occurrence，再读同一会话，重读 occurrence 仍为 failed。返回的历史片段不含冒充执行终态的 `status`。

同时断言没有源会话提交、后台追问、延期、新建定时任务、状态修改或后台启动。既有测试继续覆盖用户明确要求后台工作时追问只入队一次、不隐式延期；后台授权测试校验分类结果格式和当前用户消息隔离，不证明模型的意图识别能力。

Controller 全量单元测试：193个文件通过、11个跳过；2537项通过、159项跳过。类型检查、构建和 `git diff --check` 通过。跳过项不是本次新增，不能算作通过。

CodeRabbit 复核后，增加实际 `direct.list` 目录回归：确认下发的指令引导 `read_session`、保留原 occurrence 失败、限制后台继续执行，并核对 occurrence 工具的覆盖范围。相关两个文件29项通过。这些断言防止指引丢失，不验证模型会遵循指引。

## 实际运行入口

执行：

```sh
pnpm --dir controller build
node tests/integration/leader/source-followup.mjs --run
```

该入口启动构建后的 Controller CLI，在临时目录和内存数据库中运行，用随机凭据连接合成节点。实际发送 HTTP 工具请求，经 Controller 的真实 WebSocket 协议取得合成证据。测试结束关闭自己的连接、进程并删除临时目录；不访问真实 daemon、Codex 聊天或微信。

观察结果：

- `/v1/tools/list` 实际返回新查询规则及新的 occurrence 范围说明；查询工具 `readOnlyHint=true`，后台追问仍为 `false`。
- 四个场景产生4条 `list_automations`、8条 `inspect_automation`、4条 `read_history`；没有其他 daemon 操作。
- 每个场景读取前后的原 occurrence 完全相同；后续报告使用独立 turn ID。
- 空结果保持空；裁剪保留 `completeHistory=false`、`truncated`、`hasOlder`；失败返回 `history_failed`。
- 源会话命令、隔离后台任务、新定时任务均为0。

基线构建和变更后构建使用同一入口，原始回读保存在本次工作区 `.runtime/verification/source-followup-before.json` 与 `source-followup-after.json`。两者工具行为相同，差异是实际下发的规则和工具说明；这也证明本次没有修复一个不存在的读取权限故障。`--output <路径>` 可保存完整指令、工具目录、请求序列和四组返回证据。

上述运行验证的结论仅为“指令已注入、工具链保持只读和证据边界”。调用顺序由验证脚本选择，没有使用模型生成预设答案；证据明确标记 `modelInference=false`、`modelToolSelectionVerified=false`。目录回归和入口契约注释补充后，重建 Controller 并再次运行四个场景均通过，证据为 `source-followup-review-after.json`。

## 生产请求配置

通过严格主机密钥校验的 SSH 读取固定配置及白名单元数据，没有向生产工具目录提交合成消息，也没有调用生产业务：

- Controller 与 Gateway 均为 `5dad01e7a196f2b8d610dbcc09698924f74713c2`，healthy。Controller 为 model 模式，Gateway 为 codex 模式，二者环境模型均为 `gpt-6.1-sol`，无命令行模型覆盖。
- Controller `runtime-settings.json`、Gateway 主提示词覆盖及 `settings/model.json` 均不存在。没有相关提示词或工具覆盖。
- 11月7日05:04（北京时间）补查当前唯一聊天工作区：没有 `.codex/config.toml`，没有聊天级 effort、profile 或 provider 覆盖。Gateway 选择为 `reasoningEffort=null`。
- Gateway 的 SDK 路径仅在 effort 非空时设置 `modelReasoningEffort`；app-server 路径仅将非空值加入 `model_reasoning_effort`，`turn/start` 不另传 effort。固定 headless 配置和权限覆盖也没有 effort。
- 同一生产凭据与本地推理凭据在进程内比较相同；凭据没有写入证据。provider 为 `leader_openai` → `https://cpa.taoai.site/v1` → Responses。

因此，被测请求使用 `gpt-6.1-sol` 并省略 `reasoning` 字段；本 Task 的执行模型仍保持 Sol + Ultra。两者属于不同配置层次。CLI 内部默认强度没有核实；不根据旧模型缓存推断，也没有主动选择 low/max 替代。

证据：`source-followup-production-persisted.json`、`source-followup-production-startup.json`、`source-followup-production-request-config-verified.json`。第一次补查因环境变量名不正确而未取得 provider 信息的 `source-followup-production-request-config.json` 也保留，不能把它作为完整配置证据。

生产旧 direct 的 SHA-256 为 `69ad0938b63fe53250b98cc2cb44dbb718b2b3eb37490dfe7b4148008661e512`；候选实际 CLI 下发的 direct 为 `87a1dc17459e1d477ada3f2c426d61fad4f29cb074cd3ea194537b5d7519d46c`。本候选尚未部署。

此前 Ultra HTTP400、真实分类器 Ultra400、远端生产凭据 Ultra400，以及仅返回固定文本的 max 连通探针全部保留。它们分别是 `source-followup-model-api-probe.json`、`source-followup-ultra-classifier-attempt.json`、`source-followup-production-ultra-api-probe.json` 和 `source-followup-model-api-max-probe.json`。这些不能阻塞或替代按生产省略 effort 的行为试验；本轮没有新增 max 请求。

## 模型自主工具选择

新增入口为 `tests/live/source-followup-model.mjs`；默认仅显示用法，必须显式 `--run`，不接入自动 CI 的外部推理。基线指令、三个相关工具说明、主提示词及授权提示词固化在 `tests/fixtures/source-followup-baseline.json`，无需本机历史文件才能运行。

```sh
pnpm --dir controller build
pnpm --dir gateway build
# 向进程提供 FOLLOWUP_API_KEY、FOLLOWUP_BASE_URL、FOLLOWUP_MODEL；生产不传 effort 时不设 FOLLOWUP_EFFORT。
node tests/live/source-followup-model.mjs --run --cases pair --output /tmp/source-followup-pair.json
node tests/live/source-followup-model.mjs --run --cases boundaries --output /tmp/source-followup-boundaries.json
node tests/live/source-followup-model.mjs --run --cases authorization --output /tmp/source-followup-authorization.json
```

旧／新版本均从隔离 Controller 的 `/v1/tools/list` 实时取得完整 **30 个 Controller 工具**。旧版只替换实际变更的指令和相关说明，不把旧证据中筛选过的三个工具当作完整目录。函数参数保留真实 MCP 的 `arguments` 外层，再由适配器解包转发到实际 HTTP 工具。

模型看到的前置上下文来自合成节点的真实发现和 failed occurrence 查询，只包含已定位机器、会话和原失败事实；后续成功正文只有模型选择 `read_session` 后才进入其上下文。工具预检单独记录，不进入模型输入。模型自主选择所有调用，脚本不预设工具序列或答案。

真实 `HttpLeaderModel` 发送 `store=false`，不带 conversation 或 previous_response_id；原生 responseOutput 仅在当前内存循环续接。落盘保存请求、实际模型、effort 字段是否存在、工具参数和返回、公开回答及 usage；推理摘要不落盘，encrypted content 仅保留哈希和长度。每场景运行一次，工具数、轮数和总时间有界。Controller 使用内存库、临时目录、随机本地凭据和不可用的执行器地址；工具转发使用显式只读白名单，变更工具即使出现在目录也会在转发前拦截。没有生产 daemon、微信或源业务写操作。

该入口使用生产 SP 的静态／动态分层构建函数，但把原生开发者指令适配为 API system 消息，把 wechat_control 适配为同名 function tools。没有加载原生 shell、code-mode、AGENTS、skills 和 CLI 默认参数，因此结论限定为 **API 配置行为对照**。

### 失败与夹具修复

失败证据没有覆盖或删除：

1. `source-followup-model-production-pair.json`：两次真实请求均 HTTP200，实际模型为 `gpt-6.1-sol`、未传 effort；旧版选 `list_sessions`，新版选 `read_session`。夹具漏解 `arguments` 外层，HTTP 转发400，不能算完整行为通过。
2. `source-followup-model-production-pair-routing-fixed.json`：从已产生的工具选择接续，没有重新抽取首步。源历史的 historyContext 不是 UUID，Controller 返回 `history_invalid_response`；两版均诚实说明读不到记录。这也不能算“有后续报告”场景通过。
3. `source-followup-model-production-pair-history-fixed.json`：修正 UUID 后，从先前最后一次工具选择接续，真实返回后续报告，两版均答对。该版本误把历史消息时间作为 fetchedAt，只能用于受此限制的合成样本。
4. `source-followup-model-production-pair-final.json`：按夹具复核修正读取时间、保留历史 item.timestamp，并使用生产的静态／动态提示词分层后，明确进行一次独立修复验证。不是对历史失败的覆盖，也不冒充同一次接续。

`source-followup-model-production-boundaries.json` 是夹具时间与分层修复前的三次边界试验；`source-followup-model-production-boundaries-final.json` 为修复后的单次边界验证。两套均保留，不选择性隐藏回答。

### 有效样本与结论

| 场景 | 模型自主调用 | 公开回答核查 |
| --- | --- | --- |
| 旧规则，有后续报告 | `list_sessions` → `read_session` | 引用08:34完成报告，保留08:00原轮次失败，说明并非完整历史 |
| 新规则，有后续报告 | `read_session` | 引用后续独立报告；保留原失败；没有微信回执，不能确认送达 |
| 新规则，空历史 | `read_session` | 返回为空，最终结果待核实；不能据此否定后来成功 |
| 新规则，裁剪历史 | `read_session` | 指出历史和正文裁剪，没有最终成功证据 |
| 新规则，读取失败 | `read_session` | 明确读取失败、最终结果未核实，不把原轮次失败扩展为最终失败 |

每次原 occurrence 重读完全相同，后台任务和新定时任务均为空；合成节点只收到 list_automations、inspect_automation 和 read_history，没有源命令。原始请求均省略 reasoning，响应 actual model 均为 `gpt-6.1-sol`。

这证明候选指令在这些合成样本中能够按预期只读查询并陈述证据边界；**旧版也答对，不能证明新规则提升了成功率或找到了历史错误的唯一根因**。样本未覆盖原生长上下文、图片插话、裁剪策略、工具传输及真实投递。

## 真实授权分类

`--cases authorization` 调用构建后的 `classifyBackgroundAuthorization`、实际 `HttpLeaderModel` 和 `LocalSettingsService.wrapModel`。旧版通过隔离 settings 覆盖旧授权提示词，新版使用当前默认；没有复制分类逻辑，也没有把 mock 返回当推理。三个输入各在旧／新规则中提交一次：

| 当前用户消息 | 旧规则实际结果 | 新规则实际结果 |
| --- | --- | --- |
| 但是他最终成功了，你不信再读一下 | `[]` | `[]` |
| 再看看刚才那个 | `[follow_up]` | `[]` |
| 让它继续核对第二项 | `[follow_up]` | `[follow_up]` |

原始记录为 `source-followup-model-production-authorization.json`，六次请求均 HTTP200、实际 `gpt-6.1-sol`、未传 effort。含糊追问的旧结果保留为不符合当前授权要求的样本；新版三个样本通过。分类结果没有交给执行器，未启动或追问任何后台会话；实际队列语义由既有明确授权测试覆盖。

## CI 与审查

此前精确 head `3497706` 的 Verify run `42279760482` 当前六项通过，Controller 为2537通过、159跳过；发布归档 run `42279760351` 通过。首次 Ubuntu daemon 两项失败日志保留：主干、前一全绿 head 和此 head 的 Go 树相同，本地定向 race 20轮通过，只重跑失败 job 一次后通过；精确时序根因未解决，本 PR 没有修改 daemon。

CodeRabbit 已实际审查 `8d27c4f` 和 `3db23fb`。目录指引、分类提示词断言和验证计划 JSDoc 已补；此前“缺真实模型分类”意见现有上述生产请求配置证据。03:34请求 `3497706` 的复审被每小时限流拒绝，draft 自动检查跳过不算实际通过。后续提交以精确 head 的 CI 和实际复审为门禁；不能转记旧 head 的结果，实时状态以 PR 与交接证据为准。

## 发布与回滚

提交保持 draft，待主控独立复核及精确 head 的 CI、实际审查门禁，不提前 ready 或自动合并。

获准部署后，还应通过 settings GET、持久文件白名单和离线组合核对生效规则。`/v1/tools/list` 是 POST，会冻结消息并更新 directContext，不能给生产主聊天提交合成 messageId 作只读探针。持久化的 `controller.prompt.direct`、`controller.prompt.background-tools`、`controller.prompt.background-authorization` 或工具自定义覆盖可能继续生效；新默认值不会擅自覆盖用户编辑。本次读取时没有这些覆盖，部署时仍需复核。实际生效规则包含新内容后，才能确认默认规则生效，不能只凭镜像版本或容器健康下结论。

本次没有数据迁移。回滚该提交即可恢复旧默认规则和工具说明，持久化自定义内容不受影响。原轮次审计、历史会话、生产记忆均未修改。
