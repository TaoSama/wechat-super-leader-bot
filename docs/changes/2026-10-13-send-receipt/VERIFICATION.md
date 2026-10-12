# 发送响应修复验证

日期：2026-10-13（Asia/Shanghai）。合同见 [TECH.md](TECH.md)。正式旧通知证据见 [此前现场记录](../2026-10-13-goal-notifications/LIVE.md)。

## 开发回归

- `pnpm --dir gateway test`：180/180 PASS。包括真实 CLI 子进程与合成本地 TLS / HTTP 的13个场景，证书通过 NODE_EXTRA_CA_CERTS 显式信任，没有关闭 TLS 校验；子进程最小环境不继承真实凭证。
- `node verify.mjs --suite integration`：PASS 6 checks，覆盖真实临时 PG、Controller HTTP/WS、Gateway 类与合成微信端点。空对象 accepted、显式非零码或响应丢失 uncertain；重启前后回执全对象相等，无重复发送。所有临时 PG 容器正常清理。
- 新增单测同时检查普通回复和通知的相同成功/拒绝合同，固定错误分类不包含合成敏感值；已有 uncertain 在新判定下仍零 claim、零 receipt 更新、零发送。
- 主控按单遍8个角度检查全部产品 diff 与调用方，未发现有证据支持的阻断项（`[]`）。这是主控单遍评审，不是完整多 Agent 扇出评审；独立协作者另行验证真实 CLI 边界。

## 独立运行观察

Verdict：PASS（仅合成网络环境，不是手机送达）。主控执行独立临时观察脚手架，直接启动构建产物 `gateway/dist/index.js`；没有测试框架、内部函数调用或替换 fetch。只访问 loopback HTTP/TLS。

1. `--establish-baseline` 正常排空2页、跳过1条合成历史，HTTP外发数为0。
2. 第一次 `--poll-once --notifications`：一条返回 HTTP200 / `{}`，另一条返回显式 ret错误；Controller记录 accepted/uncertain，CLI输出分别为1，日志分类 ILinkSendRejectedRet。
3. 边界探测：重新启动同一CLI和合成状态，再次 `--poll-once --notifications`，accepted/uncertain均为0，总发送数仍2、领取2、回执2，无重复投递或回执改写。
4. 子进程正常结束，HTTP/TLS服务关闭，合成账号/证书/状态目录删除。

关键原始观察：

```text
BASELINE batchesDrained=2 rawMessagesSkipped=1 sends=0
FIRST_START notifications={accepted:1,uncertain:1,skipped:0} diagnostic=ILinkSendRejectedRet sends=2
SECOND_START notifications={accepted:0,uncertain:0,skipped:0} sends=2 claims=2 receipts=2 duplicateSends=0
CLEANUP childProcesses=normally-exited loopbackServers=closed runtimeDirectoryRemoved=true
```

观察发现：空对象必须与空正文/响应丢失分开；HTTP成功也不能覆盖显式错误码；分类此前把微信401/403误归Controller，真实CLI相邻失败场景已验证修正。新支持范围不解析未知嵌套envelope，保持uncertain且不重发。

## 发布状态

此文档首次提交时尚未发布本次修复。正式环境仍需做 Gateway-only 镜像替换与只读核对，完成后在此补充固定提交、镜像、容器、业务/状态保留证据。手机收取仍未确认，之前两条uncertain不作重新判定。
