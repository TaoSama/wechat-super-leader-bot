# 发送响应修复验证

日期：2026-10-13（Asia/Shanghai）。合同见 [TECH.md](TECH.md)。正式旧通知证据见 [此前现场记录](../2026-10-13-goal-notifications/LIVE.md)。

## 开发回归

- `pnpm --dir gateway test`：180/180 PASS。包括真实 CLI 子进程与合成本地 TLS / HTTP 的13个场景，证书通过 NODE_EXTRA_CA_CERTS 显式信任，没有关闭 TLS 校验；子进程最小环境不继承真实凭证。
- `node verify.mjs --suite integration`：PASS 6 checks，覆盖真实临时 PG、Controller HTTP/WS、Gateway 类与合成微信端点。空对象 accepted、显式非零码或响应丢失 uncertain；重启前后回执全对象相等，无重复发送。所有临时 PG 容器正常清理。
- 新增单测同时检查普通回复和通知的相同成功/拒绝合同，固定错误分类不包含合成敏感值；已有 uncertain 在新判定下仍零 claim、零 receipt 更新、零发送。
- 主控按单遍8个角度检查全部产品 diff 与调用方，未发现有证据支持的阻断项（`[]`）。这是主控单遍评审，不是完整多 Agent 扇出评审；独立协作者另行验证真实 CLI 边界。
- 产品提交69a298b的[CI 38305945139](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38305945139)通过：macOS unit 1m46s、Ubuntu all 8m6s。均使用Node24；不是手机微信验收。

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

## 正式发布与保护退出

产品源码 `69a298b9a467d43ff1716c831456626b4bc972b1` 已推送。linux/amd64 Gateway 镜像在本机构建，save/gzip/SSH/load流式传到远端；远端未构建，没有镜像备份包。临时 Buildx v0.38.0 darwin-arm64 的SHA256与官方release digest一致：`85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344`，未安装系统插件。

发布前发现当前 Compose create 不支持 `--no-deps`；在操作前移除该参数并验证 Gateway 没有 depends_on。独立协作者只读审查及离线mock验证健康身份/new-run门槛、checkpoint除sync_buf外全对象比较、Mounts按Target归一化，未发现阻断。脚本SHA256=`27b8cdde196f5710d540e9b7a7140fd8cb943924c7d181f8428c9f6de478189c`。

只读候选预检PASS，24 commands、42 messages、2 completed goals、1 completed plan、2 uncertain notifications，无未决业务。使用 `docker stop --timeout -1` 正常排空唯一Gateway，不强杀；只重建Gateway，没有改配置、迁移数据库或重新建立入站基线。

首次脚本在create后、start前保护退出：`host-config-changed:OomKillDisable`。新容器停在created，尚未轮询。旧容器已移除，原inspect仅在退出进程内，不能追回旧字段值；不把null/false归一化猜测写成现场根因，也不声称原脚本完整发布通过。

主控随后独立核对新容器实际OomKillDisable=false，匹配未禁用OOM处理的部署配置；同时核对镜像/源码、Compose和镜像默认环境合并、用户、入口、健康命令及预算、只读根目录、权限收敛、256MiB/0.25CPU/PID128、日志/tmpfs、无发布端口、网络与只读账号/可写state挂载。部署文件hash、排空后checkpoint原始字节及六张业务表完整行摘要均通过。独立核验脚本SHA256=`5abf698e54d4cc42694c11acca6416fa6d18a4a0aa763377ba28612d30a850bf`。

通过后只启动该准确候选容器，无再次重建。新run成功轮询且Docker healthy、restarts=0；再次确认账号/部署文件未改、checkpoint除了正常sync_buf推进外全对象相同、六张业务表摘要相同、原Controller及PG容器未替换。该路径输出 `independent-release-PASS`：

```text
revision: 69a298b9a467d43ff1716c831456626b4bc972b1
image: sha256:f10b086be1913a5a090d34838c7c0ec969d41166e93a13f99dae7abfc4cb5378
container: 16a679a5394331e8c46ef7c2dd6fcc3e6115c1719c313af46cce35d3947c1e05
run: run_1791837955291_389e8e17
last successful poll: 2026-10-12T20:46:14.232Z
poll errors: 0
baseline: 2026-10-11T08:42:03.152Z
context count: 1
```

| 业务表 | 行数 | 切换前后完整行MD5 |
| --- | ---: | --- |
| commands（含input_receipt） | 24 | cc08d2efca156dd109f8e0e77e39af46 |
| messages | 42 | 926c3aae495d1de58c70f041f17519dc |
| leader_states | 4 | 08f95424c8ad325a0c5d67f77baa5fb9 |
| leader_executions | 1 | 50d9fd2580e6ee3999c0ec9803d8d52f |
| leader_goals | 2 | 5ab762969841249ae1d1e43cad865eb3 |
| leader_notifications | 2 | 4021f665682e34db7d045567d4c0987f |

Controller/Web仍为0230727，节点 A与节点 B本轮未重启或更新。原两条通知的HTTP状态仍uncertain、attempt分别为8a7867ea-6f56-5178-9f5f-bcb00da766fb和71138a3a-90d5-5834-b922-e86ea115df32，没有新建目标、模拟入站或微信测试外发。

独立正式HTTPS复核：`/v1/status`返回200，两节点connected、24命令、18条当前会话，验收fixture不在列表；Web首页200，仍引用`/assets/index-D0G0MZ4s.js`，此次没有改动已上线的筛选/长历史页面。

## 验证边界与清理

手机收取仍未确认，之前两条uncertain不作重新判定。健康轮询不代表主动投递成功。替换前失败可尝试启动原容器；替换后原脚本只保护退出，不自动回退。本次通过独立配置/数据核对后启动候选；若以后回退二进制，同样不得重写已持久化回执。

正式仓库仍PRIVATE：历史截图中的私人会话信息清理/公开选择仍待用户确认。本轮没有擅自强推改写历史或公开这些内容。临时发布/观察脚本与下载工具在本轮收口清理；没有新建Task、会话或备份，之前验收会话仍归档。建议发布规则在可能退出前保留脱敏字段差异，并逐项区分省略值与显式默认值；未擅改全局规则或技能。
