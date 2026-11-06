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

上述运行验证的结论仅为“指令已注入、工具链保持只读和证据边界”。调用顺序由验证脚本选择，没有使用模型生成预设答案；证据明确标记 `modelInference=false`、`modelToolSelectionVerified=false`。本轮不创建新 Codex 线程，因此未运行生产外层 Codex 的隔离行为验证，模型是否会主动调用仍待验收。

## 发布与回滚

提交保持 draft，待主控独立复核、精确 head CI及模型层验收，不提前 ready 或自动合并。

部署后还应只读核对实际 `/v1/tools/list` 指令。持久化的 `controller.prompt.direct`、`controller.prompt.background-tools`、`controller.prompt.background-authorization` 或工具自定义覆盖可能继续生效；新默认值不会擅自覆盖用户编辑。线上实际下发包含新规则后，才能确认默认规则生效，不能只凭镜像版本或容器健康下结论。

本次没有数据迁移。回滚该提交即可恢复旧默认规则和工具说明，持久化自定义内容不受影响。原轮次审计、历史会话、生产记忆均未修改。
