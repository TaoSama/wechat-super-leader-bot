# 不启动后端的文件会话发现

验证日期：2026-10-11。本记录覆盖独立文件发现增量，不替代正式部署与原会话发送验收。

## 设计与边界

- Controller 仍是唯一编排权威；原生 Go Daemon 将持久化身份发现与运行时控制分开。
- 显式 `--codex-home` 启用文件 catalog，不从 `CODEX_HOME` 隐式启用；不读取 SQLite，不创建 sidecar，不启动后端，不执行 resume。
- 仅解析 `sessions/YYYY/MM/DD/rollout-*.jsonl` 第一条完整、换行终止的 `session_meta`。仅提取 ID、cwd、provider、创建时间；只纳入顶层 `cli/vscode/appServer`。正文和 instructions 不解析或输出；缓冲允许预读首行后至多一个小块，但不消费后续记录。
- `session_index.jsonl` 只为已验证的身份补标题，不创建会话身份。文件时间、标题索引时间不代表运行状态；不会填写 `Session.UpdatedAt` 或猜测模型。
- 文件独有会话一律 `unknown / loaded=false / capabilities=[read]`。read 返回明确标记的元数据，不是历史。发送、历史、turn 查询仍通过原控制适配器，不增加备用发送路径。
- control 与 catalog 各自刷新并保留独立时间戳。catalog 每 15 秒读取、单次预算 8 秒；失败保留完整旧快照及原时间，绝不把部分集合当全量。合并时仅用文件标题/cwd 补空值，不能刷新旧 control 时间或扩大权限。
- 桌面 IPC 只负责独立运行状态观测；Snapshot 调用成功不代表每个会话都有 owner。probe 分别报告 control/catalog/desktop 来源，并单独核对可用 owner 数量。

目录采用非阻塞 directory FD 打开、类型检查后桥接固定 `os.Root`；后续路径受 Root 限制。sessions 根拒绝链接到 archived_sessions；文件打开后再次检查 regular 类型，目录按每批 64 项遍历。任何损坏/未写完整的候选 header、消失文件、坏 index 或容量超限均使整轮失败。

上限：首行 256 KiB、总读取 256 MiB、遍历 50000 项、5000 个独立会话；index 每行 64 KiB、总 16 MiB、10000 行。catalog 预算参照 Controller 的 1 MiB 帧上限，不混用 native backend 的 8 MiB 上限。sender 对合并后的完整 JSON（含 desktop、skills、envelope）再验实际编码字节，不截断。超限重连前有界并行刷新来源，避免 oversized hello 缓存自锁；来源恢复缩小后无需重启即可重新发送正常 hello。

## 实机发现的问题与修正依据

首次 Air probe（14:08:13.785 UTC，6538ms）为 control=true/catalog=false/desktop=true，15 会话、1 sendable；这不是 catalog 通过。显式只读诊断：

```sh
LIVE_CODEX_CATALOG_HOME=/Users/luwentao/.codex \
  go test ./pkg/codex -run '^TestLiveRolloutCatalog$' -v -count=1
```

首次失败：`rollout catalog metadata identity mismatch`（0.53s）。独立受限首行扫描找到两条 `rollout-<time>-<threadUUID>_<rolloutUUID>.jsonl`；19 个顶层记录只有 17 个不同会话。

核查当前原生源码 commit `a07c8ebd57feedc4cf5dfe854c8e9101de54186b`：

- `codex-rs/rollout/src/recorder.rs:95`：`thread/revert` 保持会话 ID，用新 rollout ID 创建不可变记录文件。
- `codex-rs/rollout/src/rollout_file_name.rs:39`：普通名称中两个 ID 相同；复合名按 `_` 拆分稳定会话 ID 与 rollout ID。
- `codex-rs/rollout/src/list.rs:1408`：同会话按文件名时间、再按 rollout UUID 排序选择最新记录。

因此不能把复合名当异常文件排除，也不能把末尾 rollout ID 当会话 ID；本轮针对当前原生格式修正，不添加旧系统兼容层。header 仍必须等于文件名中的稳定会话 ID；排序键仅供选取持久化元信息，不转换成 live 状态。

## 首次 Mac Mini 临时探测

再次核实 `ssh macmini` 为 `Wentao’s Mac mini / Mac16,10 / arm64`，用户 `/Users/macmini`。桌面 IPC 存在，共享 control socket 不存在。仅将新构建复制到 `mktemp -d` 创建的临时目录运行 `--probe`，没有覆盖远端项目或安装服务。

14:10:12.430 UTC，6091ms：control=false/catalog=true/desktop=true；发现 1 个会话，loaded=0、sendable=0、desktopAvailable=0、desktopActive=0、unknown=1。这证明不依赖共享控制接口可以发现持久化身份，但这次没有取得可用桌面 owner，不代表能观测或控制该会话。

## 最终验证

以下命令在项目 `daemon/` 执行，除另行注明外：

| 命令 | 结果 |
| --- | --- |
| `LIVE_CODEX_CATALOG_HOME=/Users/luwentao/.codex go test ./pkg/codex -run '^TestLiveRolloutCatalog$' -v -count=1` | 通过；17 个独立会话，case 0.96s；只记录数量、不输出元数据原文 |
| `go test -race ./...` | 全包通过；client 19.135s / codex 10.224s，其余包通过或缓存 |
| `go vet ./...` | 通过 |
| `go build -o bin/super-leader-daemon .` / `file bin/super-leader-daemon` | 通过，Mach-O arm64 |
| `GOOS=linux GOARCH=amd64 go build -o /dev/null .` | 通过，仅编译验证 |
| `pnpm --dir controller exec vitest run tests/session-observation.test.ts tests/session-workspace-http.test.ts tests/resolver_security.test.ts tests/multi-node.test.ts`（仓库根） | 4 文件、83 tests 通过 |
| `pnpm --dir web exec vitest run tests/session-observation.test.tsx`（仓库根） | 27 tests 通过 |
| `git diff --check`（仓库根） | 通过 |

独立审查复用原 Agent，无新增 Codex Task。最终 compound 专项三次 race 通过（7.796s）、vet 与 Linux 交叉编译通过，未发现遗留问题。完整帧限制及超限恢复三次 race 通过（3.260s）。主任务另行读取实现并跑上表测试，不把子 Agent 报告当作唯一验收。

覆盖：普通/复合文件名、稳定 ID 与 rollout ID 分离、按时间和 UUID 选取、较旧候选损坏仍拒绝整轮、A/B/A 旧排序键重复不受遍历顺序影响；首行/总量/index/帧边界；FIFO、替换、路径越界、sessions→archive 链接、归档重查、取消后 FD 回收；不解析正文、不猜测模型、不扩大权限；失败保留原快照与时间；超限后源缩小自动重连，正常网络错误不触发额外扫描。

### 最终二进制两机结果

二进制 SHA-256：`fcd85cfe572465be58fd6e8d9506a41f667029c9bca2e910abf892f7fe69388d`。Mini 上传后独立计算同值，再执行 probe。

| 时间 UTC / 场景 | 耗时 | control / catalog / desktop | 会话数 | loaded / sendable | 可用桌面 owner / active |
| --- | --- | --- | --- | --- | --- |
| 14:23:45.781 / Air 原状 | 6989ms | true / true / true | 17 | 1 / 1 | 9 / 2 |
| 14:23:51.184 / Air 显式不存在的 control 路径 | 5399ms | false / true / true | 17 | 0 / 0 | 9 / 2 |
| 14:24:35.558 / Mini 原状 | 5116ms | false / true / true | 1 | 0 / 0 | 0 / 0 |

Air 缺失 control 场景中全部 17 个原始状态均为 unknown；即使其中 2 个有只读 desktop active 观测，也没有发送能力。测试仅向 `--sock` 传入事先确认不存在的路径，没有删除真实 socket 或停止控制服务。Mini 的 1 个文件身份与前轮独立受限首行扫描数量相符，但文件目录并不证明桌面完整 inventory；不能把旧标题索引或数据库中的历史数量冒充现存可控会话。

两机 probe 均没有打开 journal、连接 Controller、发送微信/会话消息、创建会话、取得 writer 或启动后端。第二种场景明确报告 `Shared control unavailable; file discovery does not grant send capability`，未将降级静默当作完整控制成功。

## 清理、交付与仍未证明的部分

- Mac Mini 临时目录 `/tmp/super-leader-rollout-probe.hUIB2F` 只含本轮二进制；完成后已用 `/usr/bin/trash` 移入废纸篓，并确认原路径不存在，可恢复。未覆盖远端旧项目或稳定二进制。
- 合成测试的目录/socket/服务由测试回收；显式 live 测试只有读取。未创建备份、验收会话或后台常驻进程；保留所有正式 `.runtime`、PostgreSQL、Gateway baseline/checkpoint 与 Daemon journal。
- 本轮新源码、项目内构建产物和证据已完成；未更新 Air 用户服务、香港 Controller/Gateway 或安装/注册 Mini 节点。不能把这次文件发现当作跨机读写项目已经完成。
- 普通只读可能更新文件系统 atime；合成测试证明的是内容、mtime、权限及文件集合不变，不承诺所有 OS 元数据不变。已打开 FD 与并发归档不是原子快照，后续扫描重新验证；常规磁盘 I/O 的 context 也不是内核硬超时。
- Linux 尚未实机验证；压缩记录格式、所有桌面/CLI inventory、原桌面 owner 写入、Claude/Grok 等 CLI 控制、长时间休眠恢复和真实微信全链路不在本次证明范围。
- 未部署因此不需要生产回退。未来关闭文件发现时，在保留所有其他运行参数、排空后更新服务的正常流程中移除 `--codex-home`；无需修改用户会话、删除 journal 或恢复数据库。

经验建议：协议文件命名须用真实持久化样本与当前原生实现交叉核验，尤其区分会话 ID 和记录文件 ID；只读发现不能因“看起来像异常文件”静默丢失身份。本轮仅记录建议，不修改全局 CLAUDE.md、rules 或 skills。
