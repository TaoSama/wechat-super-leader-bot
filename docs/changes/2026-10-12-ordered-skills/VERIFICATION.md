# 有序技能组合与确认边界

本轮仅覆盖本地增量。线上香港仍为 `3488d3a`，Air 为 `058af3d`；本轮没有部署、修改桌面 transport、重启 App 或发送真实微信/会话任务。

## 实现合同

- 每个任务最多 4 个不同技能，保持用户顺序；小写 SHA256 ID/digest 必须有效，同 ID 不同 digest 也算重复。
- Controller 的计划、命令、持久化与协议共用引用 Schema；Go 协议入口与文件解析共用 `ValidateRefs`。
- Go 一次扫描目录，按请求顺序解析；任一缺失、变化或目录不完整整组拒绝，不返回部分可执行技能。
- 既有会话收到全部有序路径/digest 和原始任务；须完整读取所有文件、逐份核验后才执行，依赖缺失停止报告，技能不能扩大原授权。
- `read` 不允许携带技能。原空技能任务不改写 prompt。引用顺序属于原幂等 payload，不增加协议版本或数据库迁移。
- 完整预览连同附带链接超过 8000 字符时，清除待确认计划并明确拒绝，不允许截断后仍授权隐藏内容。

## 独立评审发现与修复

4 步 × 每步 4 技能的合法组合，加上合法但需 JSON 转义的长名称，可生成超过回复预算的预览。旧流程裁剪回复但保留完整 pending，导致用户可能确认未显示的后部技能。实链合成复现的工具参数 6713 字符，未超过工具参数上限；返回 8000 字符且仍保留 4 步 pending。

现在在最终回复裁剪前检查完整待确认预览，超限则清除 pending。新增回归要求重复请求返回同一拒绝，后续确认明确“没有待确认计划”，零派发。没有放宽回复预算或省略授权内容。

## 主控验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir controller exec vitest run tests/skills.test.ts` | 最终 21/21 通过；包括完整预览连同链接预算、替换旧计划、拒绝结果重放与拒绝后确认 |
| `pnpm --dir controller run typecheck` | 退出 0 |
| `node verify.mjs --suite unit` | PASS 12 checks / 退出 0：三个组件测试与构建、CLI、全包 Go race/vet、原生与 Linux 构建；此后仅加 1 项上述链接预算测试，定向复验通过 |
| `node verify.mjs --suite integration` | PASS 6 checks / 退出 0：三个构建、Compose、真实临时 PostgreSQL 整链和一次性登录 |
| `node --check test-integration.mjs`，新增两个合成测试模块 `node --check` | 全部退出 0 |
| `git diff --check` | 退出 0 |

主控全包 race 包括 client 19.848s、codex 29.605s、protocol 2.544s、skills 3.283s，未放宽既有失败断言。协作单元另有定向三轮及三包完整 race/vet，不能与主控结果累加。

### 真实接口运行证据

统一入口剔除真实业务环境并关闭 dotenv。真实 Controller 与临时 PG 接收 HTTP；真实 Go Daemon 只连接新建模拟原 owner Unix socket。技能文件为临时合成数据，没有调用真实模型或真实 App。

- 原 plain 发送、busy 拒绝、模型 patch、历史旧页/增量/fixed context/失效重读及 17 MiB 快照检查全部保留并先通过。
- 管理 HTTP 发送 4 技能，故意按 `[3,1,0,2]` 排序；原 owner 逐字核对有序 path/SHA256、全部读完再工作的约束与原始 prompt。新命令精确回执：`turnId=fixture-ordered-skills-native-turn`，`output=EXACT_ORDERED_SKILLS_FIXTURE_OUTPUT`，与 plain turn 不同。
- 相同 requestId 返回原 command/turn，反序同 requestId 返回 HTTP 409，native starts 始终仅 2（plain 与组合各 1）。
- 最后一份 SKILL.md 变化后整组拒绝，不产生第三个 native start；验证仅接受技能版本相关拒绝，不能以 busy/陈旧资格拒绝冒充该安全检查。
- HTTP 模型桩生成超长四步组合预览，返回明确拒绝；后续真实 HTTP “确认执行”得到“没有待确认计划”，零派发。
- 有序 refs 经模型计划、确认、WS、PG 与 Controller 重启后保持原序；真实 Go 组合完整 command receipt 在重启后逐字段相等。
- 持久计划、通知故障与一次性登录原回归全部通过；通知仅向模拟微信 HTTP endpoint 发送，不外发微信。

运行输出中的关键结果：

```text
PASS HTTP → PostgreSQL → real Go → original desktop owner: four ordered version-bound skills; exact original task; distinct native turn and output; same-request dedup; reordered refs → HTTP 409; changed final SKILL.md rejects the entire group without native start
PASS model HTTP → oversized four-step skill preview refused; explicit confirmation has no pending plan and no dispatch
PASS four ordered version-bound skills: model plan, confirmation, authenticated catalog, wire refs, PostgreSQL restart persistence, reordered idempotency payload rejected
[verify] PASS 6 checks (integration); synthetic fixtures only, no production acceptance claimed.
```

两个临时 PostgreSQL 容器及 fixture Controller/Gateway/Go 子进程、socket 和技能目录均由验证入口正常回收。未创建验收会话、备份、生产进程或新正式网关；既有本机 PG 与其他用户服务保留。

## 边界

SHA256 仅绑定 SKILL.md，不冻结整个依赖目录；扫描与原会话读取之间仍有变化窗口。合成 owner 验证的是派发内容、顺序和回执，不证明真实模型一定正确执行每项技能。组合能力须 Controller 与 Daemon 同步发布后才能供线上使用。Mini/公司机器、其他 CLI 主动控制、真实微信入站及持续动态自治仍未完成。

回退仅涉及本轮源码/提交，不迁移数据库、不更改 journal。未部署时无需对线上做回退。后续发布必须保留原 token、状态目录、服务参数，并在排空后成对更新 Controller/Daemon；香港低内存机器不执行镜像构建。
