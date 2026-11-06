# 后续结果只读查询的规则澄清与验证

本次变更补充用户追问后续结果时的工具选择规则。已验证实际 Controller 下发的新指令和只读工具链；尚未验证生产 Codex 模型会主动选择该路径，不能据此宣称生产回答质量问题已经修复。

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

Controller 全量单元测试：193个文件通过、11个跳过；2536项通过、159项跳过。类型检查、构建和 `git diff --check` 通过。跳过项不是本次新增，不能算作通过。

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

## 生产配置与模型验收阻塞

11月7日03:15（北京时间），通过严格校验主机密钥的 SSH 只读核对实际容器的固定设置文件和白名单元数据，没有调用生产工具目录或业务接口：

- Controller 与 Gateway 的实际镜像 revision 均为 `5dad01e7a196f2b8d610dbcc09698924f74713c2`，健康状态均为 healthy；本候选变更尚未部署。
- Controller 的 `/var/lib/super-leader-runtime/settings/runtime-settings.json` 不存在，因此没有 `controller.prompt.direct`、`controller.prompt.background-tools`、`controller.prompt.background-authorization` 或三项相关工具的持久覆盖。
- Gateway 的 `/var/lib/super-leader-gateway/settings/resources/prompts/main.md` 不存在，没有主提示词覆盖。
- Gateway 的 `settings/model.json` 不存在，实际配置选择为 `model=gpt-6.1-sol, reasoningEffort=null`。Controller 也没有模型覆盖，其环境默认模型为 `gpt-6.1-sol`。
- 两者使用 `https://cpa.taoai.site/v1`；Gateway 注册的 provider 是 `leader_openai`，`wire_api=responses`。`gateway/src/leader/codex.ts` 将非空 effort 交给 SDK；SDK 原样写入 `model_reasoning_effort`。生产没有显式 effort，不能把它说成 Ultra。缓存模型目录的默认值为 low，但记录时间为10月26日，不能用旧缓存证明当前请求的实际默认强度。

设置 GET 返回的生产 direct 内容与基线默认全文相同，SHA-256 为 `69ad0938b63fe53250b98cc2cb44dbb718b2b3eb37490dfe7b4148008661e512`。候选版本实际本地 CLI 下发的 direct 为 `87a1dc17459e1d477ada3f2c426d61fad4f29cb074cd3ea194537b5d7519d46c`。持久文件核对补足了仅凭 `stale=false` 无法排除相同全文覆盖的缺口。证据为 `source-followup-production-persisted.json` 和 `source-followup-effective-config-comparison.json`。

本 Task 保持 GPT-6.1-Sol + Ultra。无会话 API 的请求均使用 `store=false`，不带 conversation 或 previous_response_id，凭证仅在进程内使用。现有 Responses 入口对 `model=gpt-6.1-sol, reasoning.effort=ultra` 返回 HTTP 400：

```text
Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.
```

原始记录 `source-followup-model-api-probe.json` 保留不改。另保留此前一次 max 连通探针，仅证明较低强度能返回固定探针文本，没有运行模型行为对照，不能替代 Ultra 验收；主控要求后未新增 max 调用。

再次以构建后的真实 `classifyBackgroundAuthorization` 和 `HttpLeaderModel` 分别提交“再看看刚才那个”与“让它继续核对第二项”，两者均在 Ultra 参数校验阶段被同一接口拒绝，没有分类结果或工具执行，记录为 `source-followup-ultra-classifier-attempt.json`。不能把这两项算作分类通过。没有找到有证据支持的 Ultra 等价无会话入口；缓存目录列出 Ultra 不等于 Responses API 接受它，也不能据此认定 max 等价。

因此，旧/新规则下模型自主选择 `read_session`、四种历史边界的自然语言回答、含糊追问与明确继续工作的真实分类，仍未通过模型层验收。后续需要一个支持指定强度的无会话入口，或主控明确修改验证强度契约；不创建新 Codex 聊天，不对生产主聊天试验。

## 审查状态

CodeRabbit 于11月7日03:05（北京时间）实际完成对 `8d27c4f` 的 review，不能再记作因 draft 跳过。两项意见为：实际目录应包含后续只读指引；授权分类应有真实模型覆盖。前者已补目录回归及真实 CLI 断言；后者受上述 Ultra 接口限制，仍未解决。新入口函数已补充说明其隔离场景、脚本工具顺序和无模型推理边界的 JSDoc。修订后的 head 还需精确 CI 和复审；检查 success 不代表模型缺口消失。

## 发布与回滚

提交保持 draft，待主控独立复核、精确 head CI及模型层验收，不提前 ready 或自动合并。

获准部署后，还应通过 settings GET、持久文件白名单和离线组合核对生效规则。`/v1/tools/list` 是 POST，会冻结消息并更新 directContext，不能给生产主聊天提交合成 messageId 作只读探针。持久化的 `controller.prompt.direct`、`controller.prompt.background-tools`、`controller.prompt.background-authorization` 或工具自定义覆盖可能继续生效；新默认值不会擅自覆盖用户编辑。本次读取时没有这些覆盖，部署时仍需复核。实际生效规则包含新内容后，才能确认默认规则生效，不能只凭镜像版本或容器健康下结论。

本次没有数据迁移。回滚该提交即可恢复旧默认规则和工具说明，持久化自定义内容不受影响。原轮次审计、历史会话、生产记忆均未修改。
