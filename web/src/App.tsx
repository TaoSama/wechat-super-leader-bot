import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { CalendarClock, Ellipsis, LockKeyhole, LogOut, RefreshCw, Layers, LayoutDashboard, MessagesSquare, Moon, Sun, X } from "lucide-react";
import { LeaderOverview } from "./features/leader/components/LeaderOverview";
import { AutomationsSection } from "./features/notifications/AutomationsSection";
import { SessionWorkspace } from "./features/sessions/components/SessionWorkspace";
import { useStatusPolling } from "./features/status/useStatusPolling";
import { getAuthSessionSnapshot, getOrInitAuthSession, isCurrentAuthGeneration, setUnauthenticatedSession, subscribeAuthSession } from "./auth/bootstrap";
import { logoutAuthSession } from "./api/auth";
import { POLL_INTERVAL_MS, ScopedSession } from "./types";
import { sessionKey } from "./features/sessions/useSessionHistory";
import { formatTimeShort } from "./format";
import { useViewportHeight } from "./useViewportHeight";
import { SessionDialog } from "./features/sessions/components/SessionDialog";

export interface AppProps { pollIntervalMs?: number }

export function App({ pollIntervalMs = POLL_INTERVAL_MS }: AppProps) {
  const { state: authState, generation: authGeneration } = useSyncExternalStore(subscribeAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [view, setView] = useState<"sessions" | "leader" | "automations">("sessions");
  const [requestedSessionKey, setRequestedSessionKey] = useState<string | null>(null);
  const [requestedSessionRevision, setRequestedSessionRevision] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const utilityRef = useRef<HTMLDivElement>(null);
  const viewportHeight = useViewportHeight();
  const handleAuthFailure = useCallback(() => {
    if (!setUnauthenticatedSession("expired", authGeneration)) return;
    setSelectedNodeId(null);
    setView("sessions");
    setRequestedSessionKey(null);
    setDetailVisible(false);
  }, [authGeneration]);
  const authenticated = authState.status === "authenticated";
  const telemetry = useStatusPolling(authenticated, pollIntervalMs, handleAuthFailure, authGeneration);

  useEffect(() => {
    void getOrInitAuthSession();
  }, []);

  useEffect(() => {
    if (!utilitiesOpen) return;
    function closeOnOutsidePress(event: PointerEvent) {
      if (event.target instanceof Node && !utilityRef.current?.contains(event.target)) setUtilitiesOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [utilitiesOpen]);

  useEffect(() => { setUtilitiesOpen(false); }, [view, detailVisible]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === "light" ? "#f4f4f5" : "#141716";
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logoutAuthSession();
      if (!setUnauthenticatedSession("none", authGeneration)) return;
      setSelectedNodeId(null);
      setView("sessions");
      setRequestedSessionKey(null);
      setDetailVisible(false);
    } catch (error) {
      if (isCurrentAuthGeneration(authGeneration)) setLogoutError(error instanceof Error ? error.message : "退出登录失败");
    } finally { setLoggingOut(false); }
  }

  function openSession(session: ScopedSession) {
    setRequestedSessionKey(sessionKey(session));
    setRequestedSessionRevision((revision) => revision + 1);
    setView("sessions");
  }
  const connectionLabels = { connecting: "正在连接", live: "实时连接", reconnecting: "正在重连", polling: "定时更新", offline: "连接中断" };

  function toggleTheme() {
    setTheme((current) => current === "dark" ? "light" : "dark");
  }
  const utilityActions = <>
    <button type="button" className="theme-toggle" aria-label="切换明暗外观" aria-pressed={theme === "dark"} title={theme === "light" ? "切换为深色外观" : "切换为浅色外观"} onClick={toggleTheme}><Sun className="theme-sun" size={18} aria-hidden="true" /><Moon className="theme-moon" size={18} aria-hidden="true" /><span className="utility-theme-label">{theme === "light" ? "切换深色外观" : "切换浅色外观"}</span></button>
    {authenticated ? <>
      <span className={`header-connection ${telemetry.error ? "degraded" : ""}`} role="status"><span className="connection-dot" aria-hidden="true" /><span>{telemetry.error ? "状态待恢复" : connectionLabels[telemetry.connectionState]}<small>{telemetry.lastUpdatedAt ? `更新于 ${formatTimeShort(telemetry.lastUpdatedAt)}` : "正在同步状态"}</small></span></span>
      <button type="button" onClick={telemetry.manualRefresh} disabled={telemetry.isRefreshing || telemetry.isLoading} aria-label="立即刷新控制平面状态"><RefreshCw size={16} aria-hidden="true" /><span>刷新</span></button>
      <button type="button" aria-label="退出控制台登录" onClick={() => void logout()} disabled={loggingOut}><LogOut size={16} aria-hidden="true" /><span>退出登录</span></button>
    </> : <span className="header-connection"><LockKeyhole size={14} aria-hidden="true" />安全会话</span>}
  </>;

  return <div data-theme={theme} data-view={view} className={`app-shell ${authenticated ? "is-authenticated" : ""} ${view === "sessions" && detailVisible ? "mobile-detail-open" : ""}`} style={viewportHeight ? { height: viewportHeight } : undefined}>
    <a href="#main-workspace" className="skip-link">跳转至工作区</a>
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Layers size={22} aria-hidden="true" /></span><div><h1>Super Leader</h1><span>你的随身工作台</span></div></div>
      {authenticated && <nav className="primary-nav" aria-label="主导航"><button type="button" className={view === "sessions" ? "active" : ""} aria-current={view === "sessions" ? "page" : undefined} onClick={() => setView("sessions")}><MessagesSquare size={17} aria-hidden="true" />会话</button><button type="button" aria-label="工作看板" className={view === "leader" ? "active" : ""} aria-current={view === "leader" ? "page" : undefined} onClick={() => setView("leader")}><LayoutDashboard size={17} aria-hidden="true" />工作看板</button><button type="button" className={view === "automations" ? "active" : ""} aria-current={view === "automations" ? "page" : undefined} onClick={() => setView("automations")}><CalendarClock size={17} aria-hidden="true" />定时任务</button></nav>}
      <div ref={utilityRef} className={`header-actions ${utilitiesOpen ? "utilities-open" : ""}`} onKeyDown={(event) => {
        if (event.key === "Escape") { setUtilitiesOpen(false); utilityRef.current?.querySelector<HTMLButtonElement>(".utilities-toggle")?.focus(); }
        if (utilitiesOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [...utilityRef.current!.querySelectorAll<HTMLButtonElement>(".workspace-menu-actions button:not(:disabled)")];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : current < 0 ? event.key === "ArrowUp" ? buttons.length - 1 : 0 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
        <button type="button" className="utilities-toggle" aria-label="工作台选项" aria-haspopup="dialog" aria-expanded={utilitiesOpen} aria-controls={utilitiesOpen ? "workspace-utilities" : undefined} onClick={event => { event.currentTarget.focus(); setUtilitiesOpen((open) => !open); }}><Ellipsis size={16} aria-hidden="true" /></button>
        {utilitiesOpen ? <SessionDialog className="ui-popover-dialog workspace-menu-dialog" labelledBy="workspace-utilities-title" onClose={() => setUtilitiesOpen(false)}><header className="ui-popover-header"><h2 id="workspace-utilities-title">工作台选项</h2><button data-dialog-close type="button" className="icon-button" aria-label="关闭工作台选项" onClick={() => setUtilitiesOpen(false)}><X size={18} aria-hidden="true" /></button></header><div id="workspace-utilities" className="workspace-menu-actions" role="group" aria-label="工作台操作">{utilityActions}</div></SessionDialog> : <div className="utility-actions" role="group" aria-label="工作台操作">{utilityActions}</div>}
      </div>
    </header>
    <main id="main-workspace" className="main-workspace">
      {logoutError && <div role="alert" data-testid="logout-error-banner" className="notice error">退出登录失败：{logoutError}<button type="button" onClick={() => setLogoutError(null)}>关闭</button></div>}
      {authState.status === "checking" && <section className="auth-card" aria-label="正在核验控制台授权"><LockKeyhole size={28} aria-hidden="true" /><h2>正在登录…</h2><p>马上就好</p></section>}
      {authState.status === "unauthenticated" && <section className="auth-card" aria-label="控制平面认证引导">
        <LockKeyhole size={30} aria-hidden="true" />
        {authState.reason === "invalid_link" && <div role="alert" data-testid="auth-invalid-link-banner" className="notice error">当前登录链接无效或已过期，请在微信中重新索取。</div>}
        {authState.reason === "expired" && <div role="alert" data-testid="auth-expired-banner" className="notice">控制台会话已过期，请重新获取登录链接。</div>}
        <h2>把工作带在身边</h2><p>在微信中向 Super Leader 发送：</p><div className="login-phrase">给我控制台链接</div><p>打开回复中的链接，即可查看和继续会话。</p><span>链接仅供本人使用，登录有效期 1 小时。</span>
      </section>}
      {authenticated && telemetry.error && <div role="alert" data-testid="telemetry-error-banner" className="notice">连接暂时中断，正在显示上次的内容。<button type="button" onClick={telemetry.manualRefresh}>重新连接</button><details><summary>查看原因</summary>{telemetry.error}</details></div>}
      {authenticated && telemetry.isLoading && !telemetry.data && <div role="status" data-testid="telemetry-loading-state" className="workspace-loading"><span className="sr-only">正在同步机器与会话…</span>{[0, 1, 2, 3].map(row => <div key={row} className="session-skeleton" aria-hidden="true"><i /><i /><i /></div>)}</div>}
      {authenticated && telemetry.data && <>
        <div hidden={view !== "sessions"} className="workspace-panel"><SessionWorkspace data={telemetry.data} nodes={telemetry.derivedNodes} active={view === "sessions"} requestedSessionKey={requestedSessionKey} requestedSessionRevision={requestedSessionRevision} stale={!!telemetry.error || telemetry.controllerHealthy === false} onAuthFailure={handleAuthFailure} onDetailVisibilityChange={setDetailVisible} /></div>
        <section className="leader-panel" hidden={view !== "leader"} aria-label="运行状态与发送记录"><LeaderOverview data={telemetry.data} nodes={telemetry.derivedNodes} selectedNodeId={selectedNodeId} onSelectNodeId={setSelectedNodeId} onOpenSession={openSession} onBrowseSessions={() => setView("sessions")} /></section>
        <section className="leader-panel" hidden={view !== "automations"} aria-label="定时任务"><div className="leader-workspace"><AutomationsSection items={telemetry.data.automations ?? []} /></div></section>
      </>}
    </main>
  </div>;
}

export default App;
