# 全局微信额度验证记录（2026-10-31）

基线：`923d102275a215b06df2f54c481e6674bb999f8b`。验证对象为本次全局账号额度、实际收件人 token 窗口、续期提醒和待发成果恢复修改。使用隔离目录、本地 HTTP 模型与 HTTPS iLink/CDN，启动实际 Controller 和 Gateway CLI；没有生产凭据，没有发送真实微信，没有重跑生产定时任务。

## 观察到的应用行为

执行：

```sh
pnpm --dir controller build
pnpm --dir gateway build
node tests/integration/leader/result-gateway.mjs --run
```

原有场景包括完整三段文字、模型摘要加真实 AES 加密文件、额度耗尽等待、重放不续期、窗口过期、网络回执丢失和进程崩溃后的不重复发送、最后一次额度提醒、分段中提醒抢占。新增跨收件人场景从真实 CLI 发送，验证 B 刷新后 A/B 同时恢复、token 各归其人、总发送不超共享账本、A 过期不借 B 续活、A 的迟到新入站只恢复自身而不补全局额度、A 自身 22 小时到期提醒。

捕获的命令行输出：

```text
PASS actual Gateway CLI sends three complete rendered texts; cross-message emphasis removed before frozen split, raw Markdown artifact retained, shared budget and typing verified
PASS actual CLI sends one HTTP-model summary plus type4 file; real AES-128-ECB upload bytes, plaintext MD5, filelen and full-result SHA256 verified
PASS budget exhausted → durable waiting; replay does not refresh; true new inbound gets ordinary reply before result resume
PASS expired reply window saves waiting result; new inbound resumes without rerunning scheduled task
PASS lost send response and process killed after submission remain uncertain across real CLI restart without duplicate send
PASS future task reminder requires final hour and 1–2 sends; durable deduplication survives CLI restart
PASS reminder takes final quota before ready result; persisted result resumes once after true inbound
PASS three-chunk result yields at 3→2 quota; restart preserves accepted chunk; inbound resumes only remaining chunks
PASS actual CLI: B inbound resumes both recipients; reply precedes results; both recipients share one durable quota and retain distinct context tokens across restart
PASS actual CLI: B cannot revive expired A token; valid late A input resumes its waiting result without replenishing the newer shared account grant
PASS actual CLI: A token approaching 23h triggers its 22h reminder even after B refreshes the shared account window; one reminder across restart
PASS whole-result Gateway CLI runtime; 38 actual synthetic sendmessage requests, 1 encrypted CDN uploads
```

## 回归与独立审查

```text
pnpm --dir gateway exec tsc -p tsconfig.test.json
node --test --test-reporter=spec --test-timeout=60000 gateway/dist-test/tests/**/*.test.js
ℹ tests 879
ℹ pass 879
ℹ fail 0
```

独立审查发现并修复：跨收件人乱序入站没有恢复自身 waiting 成果；文字扣额与发起请求之间让出微任务；图片上传期间其他收件人刷新账号导致旧操作继续；账号窗口较新时忽略实际收件人即将过期；其他收件人成果抢占用户回复的共享额度。5 条新增回归覆盖后四类，真实 CLI 覆盖乱序恢复和到期提醒；两个边界测试文件共 16/16 通过。复用、简化与效率检查未留下需要额外重构的问题。

旧按聊天独立额度的测试预期已按共享账本修正，不能继续期待另一聊天各得一次配置额度。并发公平测试现明确验证另一收件人发送会消耗同一轮额度，下一次真实入站才让旧回复继续。`git diff --check` 通过。

## 边界与迁移

生产只支持单 Gateway 实例、同一持久状态文件；没有声称多个独立进程或文件原子共享。旧账本没有逐次消费时间，迁移保守汇总重叠窗口消费，可能暂时少给；下一次有效真实入站恢复正常 10 次。23 小时窗口、第 22 小时起且只剩 1/2 次的提醒门槛保持。

本地模拟证明请求、扣额、持久化与恢复逻辑；不把它表述为生产微信真实送达。生产发布 revision、容器健康和窗口值由自动部署日志单独核对。没有修改 Controller runtime/数据库卷布局，没有迁移整包旧 worktree 修复。旧改动与未核实历史的边界见[遗留审计](legacy-worktree-audit-2026-10-31.md)。
