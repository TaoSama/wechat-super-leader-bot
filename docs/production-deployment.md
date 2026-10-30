# 生产部署

`.github/workflows/deploy-production.yml` 只监听 `main` 的 push。合并 Pull Request
会产生一次 main push，因此不会再叠加 `pull_request.closed` 触发。`workflow_dispatch`
用于人工重跑同一个 main revision；`deploy-production` 并发组不取消正在进行的发布。

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

Gateway 默认使用 24 小时回复窗口（`GATEWAY_CONTEXT_WINDOW_MS=86400000`），并在最后 1 小时发送续期提醒。发布脚本会把该值写入不可变的 release env，并在容器健康检查后读取实际容器环境核对；生产环境文件中的旧值不会覆盖本次发布。回滚使用上一份 release env，恢复上一版本的窗口配置。

同仓库且由仓库所有者创建的非草稿 Pull Request 会由
`.github/workflows/enable-auto-merge.yml` 自动开启 squash merge；工作流不检出或执行
Pull Request 代码。`main` 的保护规则应要求 Ubuntu unit/integration 验证和 macOS 15
验证通过。合并产生的 `main` push 会唯一触发生产部署；部署成功必须同时核对合并 revision、
容器健康状态、`gateway_context_window_ms=86400000` 和 `deployment verified`。

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
