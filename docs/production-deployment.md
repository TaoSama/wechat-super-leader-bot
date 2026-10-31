# 生产部署

`.github/workflows/deploy-production.yml` 监听 `Verify` 的 `workflow_run.completed`。
`GITHUB_TOKEN` 自动合并产生的 `push` 和 `pull_request.closed` 都不会启动后续工作流，
因此部署以 Verify 完成为入口，再通过 GitHub API 核对成功的同仓库 PR 验证、仓库所有者
身份、非草稿、当前 PR head、合并状态和实际 merge SHA。自动合并尚未结束时最多等待
5 分钟；未合并且没有开启自动合并的 PR、失败验证、fork、旧 head、非 main 目标均跳过。
API 错误和等待超时会失败，不会进入生产发布。

保留 `pull_request_target.closed` 作为人工合并入口：即使 CI 通过数小时后才合并，
也会重新查询该 PR head 对应的成功 Verify，再执行相同的合并和当前主干门禁。
机器人合并依赖 `workflow_run`，两个入口偶尔重叠时由串行队列和远端幂等检查去重。

实际合并 SHA 必须仍是当前 main。发布 job 使用 `deploy-production` 并发组和
`queue: max`，串行处理、最多保留 100 个待发布 job，不取消正在执行的发布。
排队后、镜像构建后和远端激活前都会重新检查 main；版本被更新时拒绝发布旧 SHA。
只检出主干上的可信门禁脚本和核实后的合并提交，不执行 PR head 或使用 PR artifacts。
`workflow_dispatch` 保留为人工恢复入口，且只接受调用时的当前 main revision。

工作流在一个 Ubuntu runner 中并行构建 Controller 和 Gateway 的 `linux/amd64`
Docker 归档。两个归档都带有完整 commit SHA 的 `org.opencontainers.image.revision`
标签，并在传输前检查平台、revision 和 SHA-256。归档通过固定 `known_hosts` 的 SSH
连接复制到 VPS，再由 `scripts/deploy/remote-release.sh` 完成以下顺序：

1. 只读检查 Docker、Compose、生产 env 文件、Compose 配置和现有安全策略。
2. 校验归档 SHA-256，加载镜像，并再次检查平台和 OCI revision。
3. 用 `deploy/compose.release.yaml` 给现有 `compose.yaml`、生产和 Gateway overlay
   注入不可变镜像名；不创建新 volume，也不执行 `down`。
4. 以 `--no-build --force-recreate` 重新创建 Controller/Gateway，等待两个健康检查
   成功，再检查运行状态、镜像和 revision。数据库、Controller runtime、微信账号和
   Gateway 状态路径由现有 Compose 配置继续管理。

重复触发同一版本时，只有 release env 完全一致、Controller/Gateway 的实际镜像 ID 和
revision 一致、容器健康、Gateway 窗口正确才跳过重建；上一版回滚选择保持不变。
健康检查失败时，脚本会恢复上一次 `.runtime/release.env` 并尝试重新启动旧镜像，随后
以失败状态结束。首次发布没有可回滚版本；Compose、Docker、SSH、归档校验或旧版本
重启失败都会在对应停止点失败，工作流不会报告部署成功。成功发布后只清理同名仓库中
已被替代的镜像 tag，并保留当前和上一版本供一次回滚使用；临时归档和脚本会清理。
生产容器日志仍由现有的 `json-file` 10 MiB × 3 轮转策略限制。

VPS 的 `DEPLOY_PATH` 只需要提供现有的 Compose 项目目录；每次发布会把与镜像相同
revision 的 `compose.yaml`、生产/Gateway overlay 和 seccomp 策略随发布包传输并校验，
因此不会复用旧的声明式配置。首次启用前，在该目录创建权限不向组和其他用户
开放的 `.runtime/controller.env`，并准备已有的微信账号文件、状态目录和
`super-leader-codex` AppArmor profile。工作流不会读取、打印或上传这些运行时密钥。

Gateway 在单实例的持久状态中维护账号共享发送账本；不同任务、业务会话和收件人合计使用 10 次额度。`context_token` 和窗口仍按实际收件人保存，其他收件人的新消息不能续活过期 token。升级会保守迁移旧的分聊天账本，不额外补发额度；下一条有效新入站正常刷新。

Gateway 默认使用 23 小时回复窗口（`GATEWAY_CONTEXT_WINDOW_MS=82800000`）。存在任务或可恢复的待发内容时，仅在最后 1 小时且有效剩余额度为 1 或 2 次时发送续期提醒，剩余至少 3 次不提醒；完整计算和优先级见 [README](../README.md#微信回复窗口与提醒)。发布脚本会把窗口值写入不可变的 release env，并在容器健康检查后读取实际容器环境核对；生产环境文件中的旧值不会覆盖本次发布。回滚使用上一份 release env，恢复上一版本的窗口配置。

同仓库且由仓库所有者创建的非草稿 Pull Request 会由
`.github/workflows/enable-auto-merge.yml` 自动开启 squash merge；工作流不检出或执行
Pull Request 代码。`main` 的保护规则应要求 Ubuntu unit/integration 验证和 macOS 15
验证通过。Verify 完成事件经过合并门禁后触发生产部署；部署成功必须同时核对合并 revision、
容器健康状态、`gateway_context_window_ms=82800000` 和 `deployment verified`。

首次引入监听器时，工作流必须先存在于默认分支才会接收 `workflow_run`。安装该监听器
的 PR 可能已经完成 Verify 才合并，不能假设它会自动部署自己。此时应分别记录修复合并、
人工恢复发布和之后正常 PR 合并触发的自动发布；人工 dispatch 或重跑旧 CI 不能作为
正常自动合并链路已验收的证据。工作流事件应为 `workflow_run`，门禁日志中的源 Verify
run、PR head、merge SHA 应与生产镜像 revision 一致。

回退部署触发逻辑应通过新 PR 恢复配置，并保留必要的人工发布入口。运行时发布失败沿用
上一版本镜像回滚，不执行数据库迁移或修改持久化布局。main 若在最后一次版本检查后、
远端激活过程中更新，当前发布可能短暂落后；全局串行队列随后处理新版本，旧版本不会
在一个已经完成的新版本发布之后反向覆盖它。排队超过 100 个 job 时需人工处理取消的发布。

在 GitHub `production` Environment 中配置以下 **Secrets**：

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_PORT`（可选，默认 `22`）
- `DEPLOY_SSH_PRIVATE_KEY`
- `DEPLOY_KNOWN_HOSTS`

配置以下 **Variables**：

- `DEPLOY_PATH`
- `DEPLOY_ENV_FILE`（可选，默认 `.runtime/controller.env`）
- `DEPLOY_URL`（可选，仅用于 Environment 页面链接）

建议为 `production` Environment 配置 required reviewers，并限制允许部署的分支为
`main`。本地只读检查可运行：

```sh
actionlint .github/workflows/deploy-production.yml .github/workflows/verify.yml
bash -n scripts/deploy/remote-release.sh
docker-compose --env-file /dev/null --profile wechat \
  -f compose.yaml -f deploy/compose.production.yaml \
  -f deploy/compose.gateway.yaml -f deploy/compose.release.yaml \
  --env-file .runtime/controller.env config --quiet
```

旧版 actionlint（如 1.7.12）尚未识别 GitHub 新增的 `concurrency.queue`；可针对这一项
使用 `-ignore 'unexpected key "queue"'` 检查其余规则，并以 GitHub 实际工作流解析为准。
