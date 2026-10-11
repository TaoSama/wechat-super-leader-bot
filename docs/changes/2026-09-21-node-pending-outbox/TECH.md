# 节点 Pending Result 可选 JSON Outbox 持久化与跨进程排他锁

为 NodeAgent 提供可选的磁盘 pending-result JSON outbox，解决节点进程异常退出或断电重启后内存 pending 结果丢失的问题。范围严格受控：默认行为保持不变，仅在显式传入 spool_dir 时启用落盘、恢复流程与跨进程排他锁。

## 核心设计与生命周期

1. **默认行为与参数契约**：
   - `NodeAgent.__init__` 增加可选参数 `spool_dir: str | os.PathLike[str] | None = None`，默认为 `None`。
   - `spool_dir=None` 时行为与既有实现完全一致：结果仅保存在内存 `self._pending_result` 中，不读写任何磁盘文件。
   - `spool_dir` 传入非空路径时转为 `Path` 对象，支持传入目录路径（默认使用 `pending-result.json`）或直接指定 `.json` 文件。若传入空字符串或纯空白字符，立即抛出 `ValueError`。
   - CLI 暴露：在 `src/super_leader/__main__.py` 中为 `--node-agent` 模式增加 `--node-spool-dir` 可选参数，并将解析出的目录传给 `NodeAgent` 实例。

2. **跨进程 flock 排他保护**：
   - 当 `spool_dir` 启用时，`NodeAgent.run()` 生命周期在 `spool_dir` 目录下持有 `node.lock` 排他锁。
   - 调用 `_acquire_process_lock()` 时以非阻塞独占模式 `fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)` 尝试加锁；若已有其他进程运行持锁，立即抛出 `RuntimeError("spool directory lock is held by another process: ...")`，防止多个节点实例并发竞争破坏同一个 outbox 状态。
   - 在 `run()` 的 `finally` 块中通过 `_release_process_lock()` 安全调用 `fcntl.flock(fd, fcntl.LOCK_UN)` 并关闭句柄，保证即使发生异常或接收中断信号也能可靠释放文件锁。
   - `spool_dir=None` 时不创建也不锁定 `node.lock`，仅依靠既有进程内 `_run_lock` 互斥。

3. **执行完成原子落盘**：
   - 在 `dispatch_once` 中，当任务执行完成（无论状态是 `completed` 还是 `failed`），先设置内存 pending 状态与领取身份 `(server_url, name, token)`。
   - 随后调用 `_write_pending_outbox()`：先确保目录存在（权限 `0700`），将包含 `server_url`、`name`、`token`、`task_id`、`status`、`result` 的 JSON 结构写入同目录下的临时文件（带隐藏前缀与进程/时间戳后缀），执行 `flush()` 与 `os.fsync()` 后，通过 `os.replace` 原子替换至目标 outbox 文件。
   - 若原子落盘过程抛出异常，阻止上报流程，保证不会在未落盘的情况下对外宣称结果已处理。

4. **终态确认与原子清理**：
   - 落盘后，调用 `_flush_pending_result()` 向服务端 `/nodes/task-status` 上报结果。
   - 只有当服务端明确返回 `{"updated": True}` 时，才调用 `_delete_pending_outbox()` 删除磁盘文件，并清空内存 `_pending_result` 与 `_pending_identity`。
   - 若上报遭遇网络故障、超时、429/5xx 重试耗尽，或服务端返回 `{"updated": False}` 等非 True 确认，磁盘 outbox 文件与内存状态均严格保留，下一次调度只重试补报，绝不重复领取或重新执行新任务。

5. **重启身份绑定与防提权设计**：
   - 重启时通过 `_load_pending_outbox()` 加载已有落盘文件，严格校验 JSON 结构、重复键及所有必要字段（`server_url`、`name`、`token`、`task_id`、`status`、`result`）；若文件损坏或存在多个候选 outbox，Fail-Closed 抛错。
   - **禁止放宽注册身份与禁止自动使用落盘 token**：加载 pending 状态后，`self.token` 保持为 `None`，绝不从磁盘文件自动填充凭据。若外部调用 `register()`，因存在 pending 结果立即抛出 `RuntimeError("pending task result must be acknowledged before re-registering")`，禁止通过重新注册覆盖或绕过原任务身份。
   - 补报必须由测试注入或运行环境显式设置与原任务一致的 `agent.token = <orig_token>`。若未注入 token、token 不一致、或 `server_url`/`name` 变更，`_validate_pending_identity()` 均拒绝上报并抛错。

## 验证与证据边界

- 单元测试：在 `tests/test_node_outbox.py` 与 `tests/test_cli_node_isolation.py` 补充用例，完整覆盖：
  - 默认 `spool_dir=None` 不产生文件且保持纯内存语义；
  - 路径参数校验（字符串、Path 对象、空串拒绝）；
  - 任务成功与异常失败下的原子落盘及字段完整性；
  - 服务端确认 `updated=True` 后 outbox 自动清理；
  - 网络错误、超时耗尽、服务端非 True 拒绝时 outbox 文件持久保留；
  - 原子落盘写入失败时阻断后续上报；
  - 重启后拒绝 `register()`、未注入 token 或身份不符时拒绝调度与 run；
  - 注入正确 token 后通过 `dispatch_once` 与 `run()` 成功恢复并补报；
  - 损坏 JSON、缺少必要字段、重复键、多 outbox 文件场景下的 Fail-Closed 校验；
  - 结合 SQLite `NodeRegistry` 的端到端节点崩溃重启与断网重连恢复测试；
  - `node.lock` 跨进程 flock 在 `run()` 生命周期中的持有与退出释放验证；
  - 外部持锁时 `run()` 立即抛出竞争异常拒绝启动；
  - CLI `--node-spool-dir` 正常解析传递与默认 `None` 回退验证。
- 回归测试实测（历史记录）：`pytest tests/test_node_*.py tests/test_cli_*.py` 173 passed；全量 `pytest` 555 passed。当前后续边界测试加入后，全量 `pytest` 实测为 563 passed；`compileall` 与 `git diff --check` 通过。
- 证据边界：测试均为本地 SQLite、Mock HTTP 回环与本机 flock 验证，未连接公网控制面或真实物理断电场景。
