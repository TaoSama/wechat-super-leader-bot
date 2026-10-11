# 任务计划进度视图验收

日期：2026-10-12。结果仅代表本地源码、临时 Controller/PostgreSQL 与浏览器合成场景；没有更新香港 Controller/Web、已安装 Daemon，没有发送真实微信或原会话消息。完整项目仍未完成。

## 实现结果

- `controller/src/console/executions.ts`：同一 HTTP/SSE 状态快照提供只读执行投影。当前允许名单在 LIMIT 前过滤，active 优先、创建时间与 ID 降序；取 13 条判断是否还有更多，仅展开 12 条、每条最多 4 步、每步最多 512 Unicode code points。
- `controller/src/store/execution-postgres.ts` 和 Memory 实现：持久执行独立列表与校验；复用精确命令关联，不依赖最近 50 条命令窗口猜测状态。
- `web/src/execution-contract.ts`：HTTP/SSE 共用必填契约解析。缺失、null、错误状态或依赖等明确报错，不降级为空列表；不做旧协议兼容。
- `web/src/components/ExecutionsSection.tsx`：摘要优先展示内容、进度和时间，UUID 放展开详情；仅 completed 计入进度，展示跨机依赖和准确原会话入口。筛选某台机器仍保留完整计划；不存在的目标禁用跳转。没有新增刷新计时器或计划写入口。
- 完成状态与步骤回执暂时不一致时显示待核对，rules/未知模式不会声称自动推进；已取消或过期时保留已有 accepted/completed 回执。

## 自动化验证

在项目根目录执行：

```sh
pnpm --dir controller run typecheck
pnpm --dir controller run build
pnpm --dir controller test
pnpm --dir web run build
pnpm --dir web test
node test-integration.mjs
git diff --check
```

结果：Controller typecheck/build 通过，35 文件 / 513 tests 通过；Web build（含 `tsc --noEmit`）通过，最后独立复跑 14 文件 / 276 tests 通过。不是把各轮测试数相加。真实临时 PostgreSQL + Controller HTTP/WS 集成两轮退出 0，第二轮包含审查修正。

新增或增强覆盖：

- 允许名单在限量前过滤、空名单、active/时间/ID 排序、clone 与 PG 关闭重开、hasMore、有界摘要、敏感字段白名单、坏元数据拒绝。
- 真实一次性链接换 Cookie 后读取计划；Cookie 仍不能访问通用 `/v1/messages`、`/v1/commands` 写接口。
- 未确认预览在 HTTP/SSE 均不可见；确认后每一步的 HTTP 投影与 SSE 精确匹配；accepted 不是 completed。
- 取消后受理步骤的迟到完成仍保留，但后继不派发；允许名单撤销、重启及迟到回执不能复活计划。
- 注销发出 `auth-expired`、关闭 SSE，后续状态读取 401。首次无效 HTTP 数据明确错误，已有快照遇无效 SSE 时保留并标示陈旧。

主任务新增 `test-plan-console.mjs`，接入 `test-plan-execution.mjs`；真实存储排序断言位于 `test-plan-store.mjs`。独立审查发现两处验证缺口并已修复：SSE 握手仅在响应头阶段设 5 秒截止，不误杀长期流；排序数据加入“较旧 active / 较新 cancelled / 同时刻不同 ID”，使断言真正区分三个排序维度。修正后真实集成再次全部通过。

## 浏览器实际操作

复用 TaskSpace 37 / p1，生产 Web build 加 loopback 合成 fixture：

```sh
node web/tests/workspace-fixture.mjs --port 0
```

此次分配 `http://127.0.0.1:56428`；`POST /fixture/plans?mode=...` 只切换测试状态，未连接真实账号或原 owner。

| 场景 | 实际观察 |
| --- | --- |
| 初始三步跨机计划 | 显示 1/3；第二步“已受理·尚未完成”；第三步等待步骤 2 精确完成 |
| 准确会话导航 | 点击步骤 2，打开 macair / fixture-review“数据库事务与回执关联复核”及其输入框，未发送 |
| macmini 筛选 | 只保留含该机器的计划，但 macair 前驱和全部三步仍显示 |
| uncertain → completed | SSE 实时显示暂停后续且仍为 1/3；完成场景变为 3/3、计划已完成 |
| cancelled | 已受理第二步保持 accepted，后继显示取消；提示不会停止原会话已有任务 |
| active 但已过期 | 显示“授权到期，计划待核对”，已有 accepted 保留，不伪造持久 expired 状态 |
| invalid → initial | 无效状态显示错误与上次成功快照，不显示空列表；恢复并刷新后返回三条计划 |
| 缺失目标 | old-node / missing-session 跳转按钮 disabled，不跳往其他会话 |
| overflow / empty | 12 条及“不是全部历史”提示；空场景明确当前窗口没有已确认计划 |
| 退出登录 | 计划和会话清除，回到微信一次性链接认证引导 |

浏览器脚本一次因预期文案写成“推进授权已到期”超时；实际界面是设计契约中的“授权到期，计划待核对”。检查当前 DOM 与源码后改正断言并通过，没有为迁就测试改应用。

桌面 1440×1000、竖屏 390×844、横屏 844×390 均实际截图查看；三种宽度无页面横向溢出，展开步骤可纵向阅读。这里是 Chromium 视口模拟，不代表真实手机软键盘或微信内置浏览器已验收。

- [桌面概览](evidence/desktop-overview.png)
- [桌面展开](evidence/desktop-steps.png)
- [手机竖屏](evidence/mobile-portrait.png)
- [手机横屏](evidence/mobile-landscape.png)

末次 fixture metrics：`latest=1, older=0, statuses=6, sends=0, contexts=1, expiredHistoryRequests=0, planUpdates=9`。本轮未重测历史翻页，相关能力沿用此前独立验收。

## 清理与未证明项

- TaskSpace 37 已单次 `finish({keep:[]})` 完成；fixture 经自身 `/fixture/stop` 正常退出 0。真实集成临时容器查询为空；未清理生产数据、token 或 journal，未创建备份或新验收会话。
- 浏览器提示有更新；未经用户授权未升级。
- 只读投影不是执行与命令更新的同一事务快照；界面显式处理短暂不一致。最多 12 条并非完整历史，不新增确认、取消、重试管理权限。
- 当前仍是既有全局操作者控制台，不声明聊天之间的多租户隔离。固定依赖计划不包含跨步骤结果传递、动态重规划或主动微信完成通知。
- 线上与已安装 Daemon 保持原版本，Mac Mini 原 owner 能力没有因本机或合成测试成功而得到证明。
- 回退时应同步回退 Controller/Web 发布，不能仅回退一端后用默认空数组兼容新必填字段。本轮没有部署，因此没有生产回滚操作。

设计技能影响限于层级：摘要展示可读内容、进度与时间，把技术 ID 放详情，沿用工作台主题；未重做全站样式。建议后续规范持续区分“历史可读”“原会话可控”“回执完成”，本轮未修改全局规则或技能。
