import { useState, useEffect, useCallback } from "react";
import { LockKeyhole, LogOut, RefreshCw, Layers, LayoutDashboard, MessagesSquare } from "lucide-react";
import { LeaderOverview } from "./features/leader/components/LeaderOverview";
import { SessionWorkspace } from "./features/sessions/components/SessionWorkspace";
import { useStatusPolling } from "./features/status/useStatusPolling";
import { getOrInitAuthSession, setUnauthenticatedSession, subscribeAuthState } from "./auth/bootstrap";
import { logoutAuthSession } from "./api/auth";
import { POLL_INTERVAL_MS, AuthState, ScopedSession } from "./types";
import { sessionKey } from "./features/sessions/useSessionHistory";
import { formatTimeShort } from "./format";

export interface AppProps { pollIntervalMs?: number }

export function App({ pollIntervalMs = POLL_INTERVAL_MS }: AppProps) {
  const [authState, setAuthState] = useState<AuthState>({ status: "checking" });
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [view, setView] = useState<"sessions" | "leader">("sessions");
  const [requestedSessionKey, setRequestedSessionKey] = useState<string | null>(null);
  const [requestedSessionRevision, setRequestedSessionRevision] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const handleAuthFailure = useCallback(() => {
    setUnauthenticatedSession("expired");
    setAuthState({ status: "unauthenticated", reason: "expired" });
    setSelectedNodeId(null);
    setView("sessions");
    setRequestedSessionKey(null);
  }, []);
  const authenticated = authState.status === "authenticated";
  const telemetry = useStatusPolling(authenticated, pollIntervalMs, handleAuthFailure);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribeAuthState((state) => { if (!cancelled) setAuthState(state); });
    void getOrInitAuthSession().then((state) => { if (!cancelled) setAuthState(state); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logoutAuthSession();
      setUnauthenticatedSession("none");
      setAuthState({ status: "unauthenticated", reason: "none" });
      setSelectedNodeId(null);
      setView("sessions");
      setRequestedSessionKey(null);
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出登录失败");
    } finally { setLoggingOut(false); }
  }

  function openSession(session: ScopedSession) {
    setRequestedSessionKey(sessionKey(session));
    setRequestedSessionRevision((revision) => revision + 1);
    setView("sessions");
  }
  const connectionLabels = { connecting: "正在连接", live: "实时连接", reconnecting: "正在重连", polling: "定时更新", offline: "连接中断" };

  return <div className="app-shell">
    <a href="#main-workspace" className="skip-link">跳转至会话工作区</a>
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Layers size={22} aria-hidden="true" /></span><div><h1>Super Leader</h1><span>会话与指令工作台</span></div></div>
      {authenticated && <nav className="primary-nav" aria-label="主导航"><button type="button" className={view === "leader" ? "active" : ""} aria-current={view === "leader" ? "page" : undefined} onClick={() => setView("leader")}><LayoutDashboard size={17} aria-hidden="true" />Super Leader</button><button type="button" className={view === "sessions" ? "active" : ""} aria-current={view === "sessions" ? "page" : undefined} onClick={() => setView("sessions")}><MessagesSquare size={17} aria-hidden="true" />会话</button></nav>}
      <div className="header-actions">
        {authenticated ? <>
          <span className={`header-connection ${telemetry.error ? "degraded" : ""}`} role="status"><span className="connection-dot" aria-hidden="true" /><span>{telemetry.error ? "状态待恢复" : connectionLabels[telemetry.connectionState]}<small>{telemetry.lastUpdatedAt ? `更新于 ${formatTimeShort(telemetry.lastUpdatedAt)}` : "正在同步状态"}</small></span></span>
          <button type="button" onClick={telemetry.manualRefresh} disabled={telemetry.isRefreshing || telemetry.isLoading} aria-label="立即刷新控制平面状态"><RefreshCw size={16} aria-hidden="true" /><span>刷新</span></button>
          <button type="button" aria-label="退出控制台登录" onClick={() => void logout()} disabled={loggingOut}><LogOut size={16} aria-hidden="true" /><span>退出登录</span></button>
        </> : <span className="header-connection"><LockKeyhole size={14} aria-hidden="true" />安全会话</span>}
      </div>
    </header>
    <main id="main-workspace" className="main-workspace">
      {logoutError && <div role="alert" data-testid="logout-error-banner" className="notice error">退出登录失败：{logoutError}<button type="button" onClick={() => setLogoutError(null)}>关闭</button></div>}
      {authState.status === "checking" && <section className="auth-card" aria-label="正在核验控制台授权"><LockKeyhole size={28} aria-hidden="true" /><h2>正在建立安全会话…</h2><p>正在核验一次性链接或已有登录状态</p></section>}
      {authState.status === "unauthenticated" && <section className="auth-card" aria-label="控制平面认证引导">
        <LockKeyhole size={30} aria-hidden="true" />
        {authState.reason === "invalid_link" && <div role="alert" data-testid="auth-invalid-link-banner" className="notice error">当前登录链接无效或已过期，请在微信中重新索取。</div>}
        {authState.reason === "expired" && <div role="alert" data-testid="auth-expired-banner" className="notice">控制台会话已过期，请重新获取登录链接。</div>}
        <h2>需要微信一次性登录链接</h2><p>在微信中向 Super Leader 发送：</p><div className="login-phrase">给我控制台链接</div><p>打开链接即可自动登录，有效期 1 小时。</p><span>登录凭证立即从地址栏清除，草稿仅保存在当前页面内存。</span>
      </section>}
      {authenticated && telemetry.error && <div role="alert" data-testid="telemetry-error-banner" className="notice">获取会话状态失败：{telemetry.error}。当前显示上次成功快照。<button type="button" onClick={telemetry.manualRefresh}>立即重试</button></div>}
      {authenticated && telemetry.isLoading && !telemetry.data && <div role="status" data-testid="telemetry-loading-state" className="workspace-empty">正在同步机器与会话…</div>}
      {authenticated && telemetry.data && <>
        <div hidden={view !== "sessions"} className="workspace-panel"><SessionWorkspace data={telemetry.data} nodes={telemetry.derivedNodes} active={view === "sessions"} requestedSessionKey={requestedSessionKey} requestedSessionRevision={requestedSessionRevision} stale={!!telemetry.error || telemetry.controllerHealthy === false} onAuthFailure={handleAuthFailure} /></div>
        <section className="leader-panel" hidden={view !== "leader"} aria-label="运行状态与发送记录"><LeaderOverview data={telemetry.data} nodes={telemetry.derivedNodes} selectedNodeId={selectedNodeId} onSelectNodeId={setSelectedNodeId} onOpenSession={openSession} onBrowseSessions={() => setView("sessions")} /></section>
      </>}
    </main>
  </div>;
}

export default App;
