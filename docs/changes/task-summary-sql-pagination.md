# 数据库层任务摘要分页

`/tasks` 改用 NodeRegistry.task_summaries，只返回当前页 task_id、node_name、status 和 SQL substr 截取的结果摘要，不再把全部任务 payload/完整 result 载入 Python 后切页。总数和页面 SELECT 在同一读事务中完成，继承现有 serialized 异常回滚；查询前仍结算过期租约。

超出总数的 offset 不发送给 SQLite，因此非常大的正整数页码不会触发 SQLite 整数绑定溢出。默认每页 5 条、摘要 300 字符与既有命令行为不变。沿用创建时间加 task_id 的确定性排序。

## 验证与证据边界

新增 4 个用例：禁止调用旧全量接口、SQL trace 确认 LIMIT/OFFSET/substr、中文/emoji 摘要、超大页码、无遗留事务和非法数据库参数。已有跨页完整遍历测试继续通过。

实测 `.venv/bin/python -m pytest -q`：345 passed in 2.59s；compileall、git diff --check 通过。仅临时 SQLite 与实际路由，无外部接口调用。SQL 路径与返回内容交叉验证，未做峰值内存/耗时测量，不能宣称已量化性能提升。

仍需 COUNT 和排序扫描，未新增索引；页码之间不共享快照，新增任务仍可移动后续页条目。SQL 文本 substr 与 Python 在内嵌 NUL 等特殊文本上的语义可能不同，未保证任意二进制样式字符串摘要保全；完整结果未改写。任务归属 ACL、可靠结果补报仍未实现。

按开发技能复用现有连接/锁和事务管理，不改数据库结构。回退恢复 app 全量读取切片，移除新查询方法和测试即可。
