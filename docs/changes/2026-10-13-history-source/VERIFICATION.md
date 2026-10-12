# 验证记录

日期：2026-10-13；本机为 MacBook Air / Mac17,3。正式部署结果另行追加，以下开发验证不代表已经上线。

## 开发与只读现场

| 验证 | 结果 |
| --- | --- |
| `node verify.mjs --suite unit` | PASS 13 checks：三组件测试与构建、Go race/vet/两平台构建 |
| `node verify.mjs --suite integration` | PASS 6 checks：真实临时 PG、HTTP/WS/Go、目标闭环及 Cookie 登录；合成业务 |
| `pnpm --dir controller exec vitest run tests/session-history-hub.test.ts tests/session-workspace-http.test.ts` | 84 tests PASS |
| Web 历史/工作台定点测试 | 修复滚动边界后 55 tests PASS，build PASS |
| `pnpm --dir web test` | 最后修改后 24 files / 446 tests PASS |
| `git diff --check` | PASS |

已有 control socket 只读测试（精确两个目标，不输出正文）：limit=1 首/次页成功；默认 30 请求分别返回 17/12 条公开条目并有更早游标，耗时约 0.05/0.02 秒。原生记录过滤后空页仍可有游标，不能把空页等同历史结束。没有发送、resume 或新后端；没有证明所有更早页或任意单项都低于 8 MiB。

全量测试不连接正式业务；显式 live test 开关仅用于上述只读现场检查。桌面根目标出现 52,405,498 字节帧声明，超限正文没有被读取；另一目标首帧超时，无大小证据。

## 评审修复

已有 nextCursor 后，最新页返回 413 时原实现仍可被近顶滚动触发自动旧页请求。新增回归在修复前失败（预期 2 次，实际 3 次）；现在只拦截自动滚动，手动重试保留原 context。换源取消、迟到旧页、Controller/API 响应绑定和 Terminal 拒绝均有测试。

## 浏览器筛选验收

真实浏览器使用 loopback 合成 fixture：1440×1000 下机器筛选 118×32、状态 156×32，选中前后尺寸不变，键盘焦点 3px；375×812 及 844×390 粗指针下 44px 高，无横向溢出。发送计数和终端输入计数均为 0。按设计技能保留触控尺寸与焦点，仅收紧局部密度。

分页入口真实交互：默认 413 → 点击显式分页 → 30 条消息出现；向上读取后保留 90 条，追加最新记录后变为 91 条，旧页仍在，阅读锚点位移 0px。375px 手机 `scrollWidth=375`；恢复自动来源清空原阅读窗口并重新显示 413，不混入分页内容。超限后两次 metrics 均为 latest=55、older=2，无自动重试；sends=0、terminalInputWrites=0。fixture 已通过 `/fixture/stop` 正常关闭。

浏览器点击旧页按钮时，定位器自动滚动已触发两次旧页加载，随后按钮移出视口导致点击超时；重新观察确认 90 条记录后不盲目重试，以旧页保留与增量更新断言验收。不是一次失败点击就宣称成功。

截图仅含合成业务：[桌面筛选](screenshots/filters-desktop.png)、[手机筛选](screenshots/filters-mobile.png)、[桌面分页](screenshots/history-paged-desktop.png)、[手机分页](screenshots/history-paged-mobile.png)、[手机错误入口](screenshots/history-error-mobile.png)。

## 微信与公开检查

用户本次真实微信请求已关联到回复中的准确登录链接：2026-10-12 18:35:24 UTC 入站，链接于 18:35:34 UTC 兑换成功；未补发或模拟该请求。凭证仅内存提取后 hash 关联，未输出 token、聊天 ID 或正文。该证据不识别用户用了哪种浏览器。

公开前全 Git 历史检查覆盖 48 commits / 4.25 MB，仅一个已核实的测试假值命中；没有跟踪运行时密钥/数据库。但旧验收截图包含真实其他会话标题及预览，仓库暂保持私有，等待用户选择移除历史截图或明确保留后公开。不擅自改写历史。
