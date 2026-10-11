# SQLite 本地索引只读验证与撤回证据

日期：2026-10-11。结论：本轮撤回本地 SQLite catalog 实现及其生产接线，不保留可误启用的开关。

## 验收边界

读取现有本地索引必须不创建或修改数据库、WAL、SHM、副本或备份；不能以 `immutable`、`nolock`、重建 sidecar 或复制数据库绕过活跃 WAL 的一致性要求。元数据索引不代表 live 状态，也不授权发送、恢复或创建会话。

本节的 Go catalog 实验只在 `t.TempDir()` 中创建合成数据库；该实验实现未读取真实用户数据库、凭证或 rollout，也未部署、启动 backend 或修改桌面应用配置。主任务此前的数据库 schema 只读核查另见本目录验证记录，不算本实验的实机零写验证。

## 版本与打开方式

验证使用 Go 1.26.4、`modernc.org/sqlite v1.53.0`，在 macOS 上运行。

URI 通过 `net/url` 编码绝对数据库路径，参数为：

```text
mode=ro
readonly_shm=1
_pragma=query_only(1)
_pragma=temp_store(2)
_pragma=busy_timeout(100)
```

每次 `sql.Open("sqlite", uri)` 后设置 `SetMaxOpenConns(1)`，再 `PingContext`，执行查询并关闭连接；打开失败也关闭连接并返回错误。

## 上游源码证据

以下位置相对于 `modernc.org/sqlite@v1.53.0/lib/`，对应锁定版本的生成源码，不能直接套用到其他版本。

| 文件与行号 | 行为 |
| --- | --- |
| `sqlite_g_000000000001feab.go:24835` | `_sqlite3WalOpen` 无条件将 WAL 打开标志设为 `SQLITE_OPEN_READWRITE \| SQLITE_OPEN_CREATE \| SQLITE_OPEN_WAL`。 |
| `sqlite_g_000000000001feab.go:24836` | 将上述标志交给 `_sqlite3OsOpen`。 |
| `sqlite_g_0000000000003a00.go:24781` | Unix VFS 将 `READWRITE` 转成 `O_RDWR`。 |
| `sqlite_g_0000000000003a00.go:24785` | Unix VFS 将 `CREATE` 转成 `O_CREAT`。 |
| `sqlite_g_0000000000003a00.go:24796` | 使用这些标志调用 `_robust_open`，因此缺失 WAL 可以被创建。 |
| `sqlite_g_0000000000003a00.go:24803` | 仅当第一次读写打开失败后，才尝试只读打开；不是优先只读。 |
| `sqlite_g_0000000000002880.go:375` | `_unixOpenSharedMemory` 检查 `readonly_shm`，开启时跳过 SHM 的 `O_RDWR \| O_CREAT` 路径。 |
| `sqlite_g_0000000000002880.go:379` | SHM 回退打开使用 `O_RDONLY \| O_NOFOLLOW`。 |

`readonly_shm` 能限制 SHM，但不能限制 WAL 创建。在该版本源码中没有找到 `readonly_wal` URI 开关。`query_only` 与 `mode=ro` 能拒绝 SQL 更新，不等于文件系统零写入。

## 已执行的三种 WAL fixture

活跃 writer 使用独立测试子进程，避免同一进程复用 writer 已经可写映射的 SHM 节点。writer 设置 WAL 模式、关闭自动 checkpoint，提交一条合成记录，然后发送 ready 信号并等待 stdin EOF；测量期间不再写入。父进程在 writer 退出前调用 catalog 的 Discover 和 Read 两条入口。

每次测量对临时目录中的所有文件记录文件名集合、SHA-256、size、mode、mtime，读取后逐项比较。未比较 atime，因此“文件不变”仅指上述已测维度。

| 场景 | 查询结果 | 文件检查 | 结论 |
| --- | --- | --- | --- |
| active WAL 与 SHM 均存在 | 能看到仍在 WAL 中的提交，Discover 与 Read 均成功 | DB/WAL/SHM 全部已测维度不变 | 通过该场景，不能推出全局零写。 |
| active WAL 存在，父进程删除合成 SHM 后再拍快照 | Discover 与 Read 均明确失败 | 不重建 SHM，已测维度不变 | 该场景 fail-closed。 |
| writer 正常关闭，完成 checkpoint，WAL 模式数据库不再有 WAL/SHM | Discover 与 Read 均失败 | 新增一个 size=0 的 `state_5.sqlite-wal` | 不满足零写要求，阻止上线。 |

后一个场景在普通测试和 race 测试中均复现，另一位审查者独立运行针对性 race 测试也得到同样结果。没有把失败改成 skip，也没有用仅 sidecar preflight 隐藏失败；preflight 与 SQLite 打开之间仍有 TOCTOU 窗口。

## 原始失败摘要

撤回前执行：

```sh
LIVE_CODEX_SESSION= LIVE_CODEX_HISTORY_SESSION= go test ./pkg/codex -run LocalCatalog -count=1 -v
LIVE_CODEX_SESSION= LIVE_CODEX_HISTORY_SESSION= go test -race ./pkg/codex -run LocalCatalog -count=1
```

针对性独立审查命令：

```sh
go test -race ./pkg/codex -run 'TestLocalCatalog(ActiveWAL|MissingSHM|Checkpointed)' -count=1
```

输出摘要，保留原测试名称和失败原因，省略未变化数据库的长摘要：

```text
--- PASS: TestLocalCatalogActiveWALZeroWrites
--- PASS: TestLocalCatalogMissingSHMZeroWrites
--- FAIL: TestLocalCatalogCheckpointedWALMissingSidecarsFailsClosed
catalog_wal_test.go:160: catalog read changed fixture files:
before=map[state_5.sqlite:{... Size:12288 ...}]
after=map[state_5.sqlite:{... Size:12288 ...}
 state_5.sqlite-wal:{Digest:[227 176 196 66 152 252 28 20 154 251 244 200 153 111 185 36 39 174 65 228 100 155 147 76 164 149 153 27 120 82 184 85]
 Size:0 Mode:-rw-r--r-- Modified:2026-10-11 21:34:42.42727475 +0800 CST}]
FAIL
```

这个 digest 对应空文件 SHA-256：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。失败前错误为 `local catalog open failed`；错误返回没有阻止 SQLite 的 WAL 文件创建。

## 独立重建 fixture 的方式

上面的 catalog 测试文件随失败实现一起撤回，因此历史命令不能在当前生产树中重跑。后续调查应在独立临时 Go 模块中锁定 `modernc.org/sqlite v1.53.0` 重建，不把该依赖或实验接线重新加入 daemon，也不对真实 `.codex` 目录执行。

writer 在单独进程里用正常可写连接创建 `state_5.sqlite`，执行以下 SQL。建表先于 WAL 切换，记录插入后保持 writer 连接开启，以确保记录只存在于尚未 checkpoint 的 WAL：

```sql
CREATE TABLE threads (
 id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
 source TEXT, model_provider TEXT, cwd TEXT, title TEXT, archived INTEGER,
 model TEXT, reasoning_effort TEXT, updated_at_ms INTEGER, preview TEXT, name TEXT
);
PRAGMA journal_mode = WAL;
PRAGMA wal_autocheckpoint = 0;
INSERT INTO threads (
 id, rollout_path, created_at, updated_at, source, model_provider, cwd,
 title, archived, model, reasoning_effort, updated_at_ms, preview, name
) VALUES (
 'wal-only', '/fixture/never-read.jsonl', 100, 100, 'cli', 'fixture-provider',
 '/fixture', 'committed in live WAL', 0, 'fixture-model', 'high', 100123,
 'fixture-preview', 'fixture-name'
);
```

reader 使用如下最小打开逻辑；这不是完整 catalog，而是用于重建同一 VFS 打开边界的片段。`databasePath` 必须是临时 fixture 的绝对路径；错误和 Close 必须检查：

```go
func readFixture(ctx context.Context, databasePath string) (id string, err error) {
    uri := url.URL{Scheme: "file", Path: databasePath}
    options := url.Values{
        "mode": {"ro"}, "readonly_shm": {"1"},
        "_pragma": {"query_only(1)", "temp_store(2)", "busy_timeout(100)"},
    }
    uri.RawQuery = options.Encode()
    db, err := sql.Open("sqlite", uri.String())
    if err != nil {
        return "", err
    }
    defer func() { err = errors.Join(err, db.Close()) }()
    db.SetMaxOpenConns(1)
    if err = db.PingContext(ctx); err != nil {
        return "", err
    }
    err = db.QueryRowContext(ctx, "SELECT id FROM threads WHERE id = ?", "wal-only").Scan(&id)
    return id, err
}
```

片段需要 `context`、`database/sql`、`errors`、`net/url` 和空白导入 `modernc.org/sqlite`。重新建立每个独立 fixture：

1. active WAL：确认 `-wal` 与 `-shm` 均非空，保持 writer 开启，拍快照，调用 reader，比较全部文件。
2. missing SHM：保持 writer 开启，仅对合成 fixture 调用 `os.Remove(filepath.Join(dir, "state_5.sqlite-shm"))`，删除后拍快照，再调用 reader。测试结束前关闭 reader，再让 writer 正常退出。
3. checkpointed：让 writer 正常关闭连接，确认目录只剩主数据库，拍快照，再调用 reader，检查是否出现空 WAL。

原测试通过关闭 stdin 后 `Wait()` 回收 writer，整个子进程有 20 秒 context 超时；所有 fixture 随测试清理。上述重建步骤是后续复现说明，不是额外实机执行记录。

## 本轮处置及后续门槛

撤回 `daemon/pkg/codex/catalog.go`、`catalog_test.go`、`catalog_wal_test.go` 及 SQLite 依赖；本文件保留实验结果。其他已验证的实时会话和桌面公平调度改动不属于本次撤回范围。

后续只有在成熟 WAL 只读 VFS 或 OS 级强制只读边界上证明所有打开、恢复、关闭路径均不创建/修改文件，并重复独立进程与缺失 sidecar 验证，才可重新考虑此方案。当前未实现或验证该替代方案。
