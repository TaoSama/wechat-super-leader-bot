import { ArrowLeft, Brain, Code2, Monitor, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiAuthError } from "../../api/errors";
import { loadSettings } from "../../api/settings";
import { AppearanceSettings, type ThemePreference } from "./AppearanceSettings";
import { ModelSettings } from "./ModelSettings";
import { ResourcesSection } from "./ResourcesSection";
import type { SettingsSnapshot } from "./contract";

interface Props { theme: ThemePreference; onThemeChange: (value: ThemePreference) => void; themeError: string | null; onAuthFailure: () => void; onBack: () => void }
type Group = "model" | "memory" | "appearance";
const groups = [{ id: "model", title: "模型", icon: SlidersHorizontal }, { id: "memory", title: "记忆与偏好", icon: Brain }, { id: "appearance", title: "外观与诊断", icon: Monitor }] as const;
export function SettingsWorkspace({ theme, onThemeChange, themeError, onAuthFailure, onBack }: Props) {
  const [group, setGroup] = useState<Group>("model");
  const [visited, setVisited] = useState<Group[]>(["model"]);
  const [advanced, setAdvanced] = useState(false);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestMs, setRequestMs] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    const start = performance.now();
    setBusy(true); setError(null);
    void loadSettings(abort.signal).then(value => { if (!abort.signal.aborted) { setSnapshot(value); setRequestMs(Math.round(performance.now() - start)); } }).catch(reason => {
      if (abort.signal.aborted) return;
      setRequestMs(Math.round(performance.now() - start));
      if (reason instanceof ApiAuthError) onAuthFailure(); else setError(reason instanceof Error ? reason.message : "设置读取失败");
    }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [refresh, onAuthFailure]);
  function show(next: Group) { setGroup(next); setVisited(items => items.includes(next) ? items : [...items, next]); }
  return <div className="settings-workspace"><header className="settings-page-heading"><div><h2>设置</h2><p>管理助手的模型、记忆与运行资源。</p></div><button type="button" className="text-button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />返回</button></header>
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{groups.map(({ id, title, icon: Icon }) => <button key={id} type="button" aria-current={group === id ? "page" : undefined} onClick={() => show(id)}><Icon size={17} aria-hidden="true" />{title}</button>)}</nav><div className="settings-content">
      {busy && !snapshot && <p role="status" className="settings-description">正在读取设置…</p>}
      {error && <div className="settings-error" role="alert">{error}<button type="button" className="text-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
      {snapshot && <>
        <div hidden={group !== "model"}><section className="settings-section"><h3>模型</h3><p className="settings-description">模型目录来自实际执行环境。新模型出现后可以刷新选择，保存的设置从下一轮生效。</p>{snapshot.scopes.map(scope => <ModelSettings key={scope.id} scope={scope} onAuthFailure={onAuthFailure} />)}<p className="settings-note">桌面会话沿用该会话本身的模型；这里的设置只影响标明的执行对象。</p></section><details className="settings-advanced" onToggle={event => { if (event.currentTarget.open) setAdvanced(true); }}><summary><Code2 size={16} aria-hidden="true" />高级资源</summary>{advanced && <ResourcesSection chats={snapshot.chats} onAuthFailure={onAuthFailure} />}</details></div>
        {visited.includes("memory") && <div hidden={group !== "memory"}><ResourcesSection memory chats={snapshot.chats} onAuthFailure={onAuthFailure} /></div>}
      </>}
      {visited.includes("appearance") && <div hidden={group !== "appearance"}><AppearanceSettings value={theme} onChange={onThemeChange} />{themeError && <p role="alert" className="settings-error">{themeError}</p>}<section className="settings-section"><div className="settings-section-heading"><h3>诊断</h3><button type="button" className="text-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新检测</button></div><p className="settings-description">显示实际连接与版本。请求耗时是浏览器到设置服务的完整往返时间。</p><dl className="settings-diagnostics"><div><dt>设置请求</dt><dd>{requestMs === null ? "尚未取得" : `${requestMs} ms`}</dd></div>{snapshot?.diagnostics.map(item => <div key={item.id}><dt>{item.label}</dt><dd className={item.status === "ok" ? undefined : "settings-error"}>{item.value}</dd></div>)}</dl></section></div>}
    </div></div>
  </div>;
}
