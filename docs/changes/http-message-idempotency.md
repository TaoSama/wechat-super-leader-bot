# HTTP 消息入口的稳定请求身份

`POST /messages` 支持可选非空字符串 message_id，例如 `{"chat_id":"a","text":"/dispatch mini run","message_id":"request-001"}`。HTTP 入口使用独立两元素 JSON 命名空间，与微信账号/聊天/client_id 三元素键区分，再传给既有路由层去重逻辑。

同一聊天相同 message_id 对已成功入队的远程任务返回原回执。不同聊天隔离，省略 ID 保持每次产生新任务的旧行为。显式空、null 或非字符串 ID 返回 400。Bearer 鉴权和聊天授权仍然先于业务副作用；不能借重放绕过撤销的聊天权限。

客户端必须为不同消息生成不同 ID，同一聊天的所有 HTTP 客户端共享命名空间。相同 ID 即使正文不同也沿用第一次成功入队的任务。不覆盖 /fork、/turn、/remember 等命令，不是全接口 exactly-once。依赖任务记录保留，没有改变既有失败/未入队重放边界。

## 验证与证据边界

新增 9 个本机 HTTP 测试：重放回执、聊天隔离、权限撤销、无 ID 兼容、六种非法类型/空值、微信命名空间隔离。测试服务器与线程已关闭。

实测 `.venv/bin/python -m pytest -q`：307 passed in 2.53s；`.venv/bin/python -m compileall -q src`、`git diff --check` 通过。

HTTP 路由和 SQLite 入队真实执行，未调用远程节点、模型或微信。数据库条数与响应任务 ID 交叉核对；没有模拟真实丢包或测量重试延迟，无外部接口事故、性能推算。使用既有幂等实现，不新增存储或配置，符合开发技能最小改动原则。结果持久化补报仍待完成。

回退仅移除 HTTP message_id 校验/键构造/透传及测试，保留微信去重和数据库数据。
