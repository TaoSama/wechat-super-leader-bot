import { RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiAuthError } from "../../api/errors";
import { loadModelCatalog, loadSettings, refreshModelCatalog, saveModelScope } from "../../api/settings";
import { ChoiceSelect } from "../../components/ui/ChoiceSelect";
import { formatTimeShort } from "../../format";
import type { ModelCatalog, ModelScope } from "./contract";

interface Props { scope: ModelScope; onAuthFailure: () => void }
export function ModelSettings({ scope, onAuthFailure }: Props) {
  const [current, setCurrent] = useState(scope);
  const [model, setModel] = useState(scope.model);
  const [effort, setEffort] = useState(scope.reasoningEffort ?? "");
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [latestNote, setLatestNote] = useState<string | null>(null);
  const [scopeChanged, setScopeChanged] = useState(false);
  const selected = catalog?.models.find(item => item.id === model);
  const dirty = model !== current.model || (effort || null) !== current.reasoningEffort;
  function fail(reason: unknown) { if (reason instanceof ApiAuthError) onAuthFailure(); else setError(reason instanceof Error ? reason.message : "模型设置读取失败"); }
  useEffect(() => {
    if (dirty || saved) { if (scope.revision !== current.revision) setScopeChanged(true); return; }
    setCurrent(scope); setModel(scope.model); setEffort(scope.reasoningEffort ?? "");
  }, [scope.revision]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true); setCatalog(null);
    void loadModelCatalog(scope.id, abort.signal).then(value => { if (!abort.signal.aborted) setCatalog(value); }).catch(reason => { if (!abort.signal.aborted) fail(reason); }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [scope.id, scope.provider]);
  async function refresh() {
    setBusy(true); setError(null);
    try { setCatalog(await refreshModelCatalog(scope.id)); }
    catch (reason) { fail(reason); }
    finally { setBusy(false); }
  }
  async function reread() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const latest = (await loadSettings()).scopes.find(item => item.id === scope.id);
      if (!latest) throw new Error("暂时无法取得该执行环境的设置");
      setCurrent(latest); setScopeChanged(false);
      setLatestNote(`服务器当前：${latest.model} / ${latest.reasoningEffort || "模型默认"}。你的选择已保留，请核对后再保存。`);
    } catch (reason) { fail(reason); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError(null); setSaved(false); setLatestNote(null);
    try { setCurrent(await saveModelScope(current, model, effort || null)); setScopeChanged(false); setSaved(true); }
    catch (reason) { fail(reason); }
    finally { setBusy(false); }
  }
  const options = catalog?.models.map(item => ({ value: item.id, label: item.label, description: item.contextWindow ? `${item.contextWindow.toLocaleString()} tokens` : undefined })) ?? [];
  if (!options.some(item => item.value === model)) options.unshift({ value: model, label: `${model}（当前设置）`, description: undefined });
  return <section className="settings-model-row"><div className="settings-section-heading"><h4>{current.label}</h4><button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />刷新目录</button></div><p>{current.effect} · {current.provider}</p>
    <div className="settings-model-controls"><div className="settings-field"><span>模型</span>{current.editable && !busy && catalog ? <ChoiceSelect label={`${current.label}模型`} value={model} options={options} onChange={next => { setModel(next); setEffort(""); setSaved(false); }} /> : <span className="settings-observed-value">{model}{busy ? " · 读取中…" : ""}</span>}</div><div className="settings-field"><span>推理强度</span>{current.editable && !busy && selected ? <ChoiceSelect label={`${current.label}推理强度`} value={effort} options={[{ value: "", label: "模型默认" }, ...selected.reasoningEfforts.map(value => ({ value, label: value }))]} onChange={next => { setEffort(next); setSaved(false); }} /> : <span className="settings-observed-value">{effort || "模型默认"}</span>}</div>{current.editable && <button type="button" className="ui-button primary settings-model-save" disabled={busy || !dirty || !selected || (!!effort && !selected.reasoningEfforts.includes(effort))} onClick={() => void save()}><Save size={14} aria-hidden="true" />保存</button>}</div>
    {catalog && <p className="settings-catalog-note">{catalog.stale ? "缓存目录 · " : ""}{catalog.source} · {catalog.version} · {catalog.fetchedAt ? `读取于 ${formatTimeShort(new Date(catalog.fetchedAt))}` : "更新时间未知"}</p>}
    {!current.editable && <p className="settings-note">当前执行环境仅支持查看。</p>}
    {error && <div role="alert" className="settings-error">{error}<button type="button" className="text-button" disabled={busy} onClick={() => void reread()}>读取最新设置</button></div>}{scopeChanged && !error && <p className="settings-note">服务器设置已变化，你的选择已保留。<button type="button" className="text-button" disabled={busy} onClick={() => void reread()}>读取最新设置</button></p>}{latestNote && <p role="status" className="settings-description">{latestNote}</p>}{saved && <p role="status" className="settings-description">已保存，{current.effect}</p>}
  </section>;
}
