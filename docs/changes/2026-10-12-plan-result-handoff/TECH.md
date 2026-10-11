# 已确认计划的跨会话结果传递

## 范围与授权

Controller 继续作为唯一编排权威。本变更只把同一已确认计划中，明确选定的前驱已记录输出作为资料交给后继；不动态改写任务、不重规划、不新增目标、不启动后端、不恢复或抢占原会话。源码实现与合成验收不等于正式部署或真实微信验收。

1. action 新增可选 `resultFrom: number[]`，一基编号、最多 3 项，顺序冻结。缺省/空数组表示不共享输出。
2. 来源必须是更早步骤，且属于该 action 的直接 `dependsOn`；去重。不接受任意命令 ID、路径或其他聊天/计划。
3. 确认预览列出每步来源、目标和任务，并明确裁剪政策。预览超长仍拒绝保存可确认计划，不裁去授权信息。
4. 所有包含终端的多步/依赖/结果传递计划均拒绝；`input-written`、idle/done、接受回执都不是精确完成证明。

## 持久输入合同

有非空 `resultFrom` 的步骤，在原有唯一 attempt 的 CAS 中同时保存 `input`；没有来源的步骤不得携带 input：

```ts
input: {
  prompt: string; // 实际投递的确定性文本，完整长度 <= 16000 UTF-16 单元
  sources: Array<{
    step: number; commandId: string; turnId: string;
    outputSHA256: string; outputLength: number; // SHA256(UTF-8)，长度为 Unicode code points
    excerpt: string; truncated: boolean;
  }>;
}
```

每来源最多 1000 code points，且 `JSON.stringify(excerpt)` 不超过 3000 UTF-16 单元（含引号及转义）；只取前缀，不拆 surrogate pair。引用身份、完整记录 hash、原记录长度、裁剪标志全部冻结。空输出保持空；缺失输出不可冒充空输出。上游回执可能已经裁剪，这里只能称“已记录输出”，不能称完整原会话结果。

实际 prompt 为原任务加固定资料说明和 JSON 附件，明确输出是不可信资料、不构成新指令或授权。序列化决定性且规范化时复核，不允许持久 prompt 与来源摘要不一致。标注不能证明目标模型绝不会服从恶意文本，这是未提供模型隔离的边界。

来源必须在权威 store 中有同一计划步骤的精确 completed send 命令，requestId、node/session、实际 prompt、skills、route、合法 turnId 全部一致；拒绝终端/inputReceipt。多级传递需使用前驱已冻结实际 prompt 核对身份。领取前采样，实际 submit 授权回调再次复验来源与快照；缺失/被篡改/非完成来源不发送。

领取不可撤销，input 与整个 attempt 不可变。重启或结果不明只查原命令/turn，不能重新采样、清空 claim 或重发。沿用现有确认事务、CAS、取消/到期/allowlist 门禁，不增加独立存储或跳过 journal/PG。

## 只读呈现合同

`ExecutionView.steps[]` 增加必有 `resultFrom: number[]`，有已冻结 input 时可带 `resultSources`。摘要字段为 `step, commandId, turnId, outputSHA256, outputLength, excerptLength, truncated`；`excerptLength` 为 code points。计划 DTO 不暴露 input.prompt、excerpt、attempt、token 或聊天标识。

此限制针对计划摘要，不是全控制台的正文保密承诺。既有认证命令查询、状态流的 commands 和“完整请求”继续如实展示已记录的实际请求文本（包括结果附件），用于审计；记录存在不证明已投递。Console Cookie 是工作台级读权限，不是按微信聊天隔离。原文“Web 不暴露 input.prompt”的范围过宽，审查后在此明确纠正；不新增隐藏正文的查询层或字符串裁切，也不改变现有鉴权。

控制台计划区只增加来源摘要：尚未领取时显示“将使用步骤…的已记录输出”，领取后显示“已冻结输入资料”及每源是否裁剪；不得把冻结误说成已送达。详情按需展开命令/turn/hash，保留原任务摘要与状态层级。微信确认、取消及恢复所用的固定计划摘要只给来源编号与裁剪提示，不拼接原始输出；模型的既有同聊天 `get_plan_progress` / `get_command` 结果查询仍可读取已授权结果，不承诺模型回答不引用正文。沿用 SSE，无新的前端写权限。

## 实现所有权

- 主控：contracts、orchestrator、terminal-plan、根临时 PG/HTTP/WS 集成、README 和本目录文档。
- daemon_sol：execution.ts、execution-scheduler.ts、execution-view.ts、新 execution-input 模块及专属测试。
- desktop_route：console/executions、execution-presentation、Web types/contract/计划组件/样式及专属测试、plan-fixture。

仅复用两协作单元，禁止创建子 Agent；不提交其他人的未验收改动。

## 验收门槛

- 未确认零命令/零传递，来源授权完整出现在预览；非法/跨计划/终端来源拒绝。
- 两节点和三步链实际传递已冻结文本；accepted、错误 turn 和无 output 不解锁发送。
- Unicode、转义、恶意指令样本、空结果、超长结果有确定性与边界测试。
- 真实临时 PostgreSQL 保存快照，Controller 重启不重发；已有 attempt 输入不可改。
- HTTP/SSE 的计划 DTO 仅含来源摘要，认证命令详情保留实际请求文本；Web 宽/窄屏、展开来源和跳转仍准确；独立主控验证。
- 未操作真实会话、微信或生产系统；自建测试进程/临时资源收尾清理。
