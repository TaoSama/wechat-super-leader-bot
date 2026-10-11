# 持久计划的控制台进度视图

## 范围与不变边界

把已确认的持久计划接入现有 Super Leader 页面和认证状态流。只做只读投影与展示，不增加浏览器确认、取消、重试或通用管理写接口，不变更调度、发送和原 owner 语义。确认前的预览不作为执行展示；取消仍通过发起计划的微信聊天进行。远端、已安装 Daemon 和真实微信均不在本轮更新范围。

## 数据契约

`GET /v1/status` 与 `/v1/events` 的同一快照新增必填 `executions`：

```ts
interface ConsoleExecutions {
  observedAt: number; // 毫秒，服务端本次投影时刻
  limit: 12;
  hasMore: boolean;
  items: Array<{
    id: string;
    status: "active" | "completed" | "failed" | "cancelled" | "expired";
    createdAt: number;
    expiresAt: number;
    steps: Array<{
      step: number;
      nodeId: string;
      sessionId: string;
      prompt: string; // 最多 512 个 Unicode code point
      promptTruncated: boolean;
      dependsOn: number[];
      status: "waiting" | "claimed" | "pending" | "accepted" | "completed" |
        "failed" | "uncertain" | "cancelled" | "expired";
      commandId?: string;
      turnId?: string;
    }>;
  }>;
}
```

1. 存储新增 `listRecentExecutions(chatIds, limit)`，只返回当前允许名单的聊天，active 优先，其次 createdAt 降序、id 降序。空允许名单结果为空；筛选发生在 LIMIT 之前。读取 13 条判断 hasMore，只展开 12 条、每条最多 4 步。
2. 使用已有 `readExecutionView` 精确匹配命令与回执，禁止从最近 50 条 commands 猜测；旧命令也必须正确显示。读取不 claim、不 submit、不推进计划。
3. 投影显式白名单，不返回 chatId、attempt/token、plan 授权对象、requestId、原始 output/error 或技能内容。当前控制台是已有全局操作者控制台，不是多租户隔离产品；不新增聊天可见范围。
4. HTTP 与 SSE 复用同一投影，沿用现有认证、失效清屏、后台隐藏暂停、断流轮询和陈旧快照提示。数据格式错误显式报错，不能降级成“没有计划”；不增加旧协议兼容分支。
5. 状态读取与命令/执行更新并非一个事务快照。界面允许短暂显示“步骤完成，计划待核对”，不能把 accepted、claimed 或 active 直接映射成工作完成。

## 展示

- 延续现有克制的工具工作台，不重做全站主题。计划区置于 Leader 指令记录之前；摘要先显示进度、状态、时间，展开后显示有序步骤与依赖。
- 只按 completed 计算完成步数。等待说明区分依赖未完成、固定目标发送资格待满足、全计划存在失败/不确定、授权已过期、已取消后续。不能编造确切的离线或忙碌原因。
- cancelled/expired/failed 的计划仍显示已领取或执行中步骤的真实回执；清楚提示取消不终止原会话，结果不明不要重发。
- 点击目标只按 `(nodeId, sessionId)` 精确定位现有会话；缺失目标禁用入口并说明。机器筛选以“计划包含该机器”为条件，保留整份跨机计划，不能隐藏前驱。
- 显示范围是最多 12 条、进行中优先；hasMore 时明确不是全部历史。不增加第二套刷新定时器。

## 分工与验证

- 后端协作：仅 controller/，存储列表、白名单投影、status 接线、后端测试。
- 前端协作：仅 web/ 的正式源码与单元测试（不修改 workspace-fixture.mjs），严格解析、计划组件、样式与实时测试。
- 主任务：本文、集成脚本、浏览器 fixture/验收、最终独立检查与记录；契约变更先协调。
- 验收覆盖允许名单过滤与排序、hasMore、有界投影、零派发、旧命令关联、HTTP/SSE 同源、Cookie 失效、非法数据不伪装空列表、跨机依赖展示、accepted/uncertain/取消语义、会话导航、实时状态变更、桌面和手机尺寸。
- 不标记完整项目完成；真实部署、demomini/公司机器、其他 CLI、动态自治和微信最终验收继续保留。
