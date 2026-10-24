import { Check, FileCode2, RotateCcw, Save } from "lucide-react";
import { useEffect, useId, useState } from "react";

export interface EditableResource {
  id: string;
  title: string;
  kind: string;
  scope: string;
  path?: string;
  content: string;
  revision: string;
  version?: string;
  updatedAt?: string;
  editable: boolean;
  reason?: string;
  effect?: string;
}
interface Props {
  resource: EditableResource;
  onSave: (resource: EditableResource, content: string) => Promise<EditableResource>;
  onReload?: () => Promise<EditableResource>;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
}

export function ResourceEditor({ resource, onSave, onReload, onDirtyChange, onSavingChange }: Props) {
  const editorId = useId();
  const [current, setCurrent] = useState(resource);
  const [draft, setDraft] = useState(resource.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reading, setReading] = useState(false);
  const [comparison, setComparison] = useState<EditableResource | null>(null);
  const busy = saving || reading;
  const dirty = draft !== current.content;
  useEffect(() => { setCurrent(resource); setDraft(resource.content); setError(null); setSaved(false); }, [resource.id]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onSavingChange?.(busy); }, [busy, onSavingChange]);
  async function save() {
    if (busy || !dirty || !current.editable) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const next = await onSave(current, draft);
      setCurrent(next); setDraft(next.content); setComparison(null); setSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败，草稿已保留"); }
    finally { setSaving(false); }
  }
  async function reread() {
    if (!onReload || busy) return;
    setReading(true); setError(null); setSaved(false);
    try { const latest = await onReload(); setCurrent(latest); setComparison(latest); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败，草稿已保留"); }
    finally { setReading(false); }
  }
  return <div className="settings-resource-editor">
    <header className="settings-resource-heading"><FileCode2 size={18} aria-hidden="true" /><div><h3>{current.title}</h3><p>{current.scope}</p></div></header>
    <dl className="settings-resource-meta">
      {current.path && <div><dt>文件</dt><dd>{current.path}</dd></div>}
      <div><dt>来源版本</dt><dd>{current.version || "unknown"}</dd></div>
      <div><dt>内容修订</dt><dd>{current.revision}</dd></div>
      {current.updatedAt && <div><dt>更新时间</dt><dd>{current.updatedAt}</dd></div>}
      {current.effect && <div><dt>生效方式</dt><dd>{current.effect}</dd></div>}
    </dl>
    {(current.reason || !current.editable) && <p className="settings-note">{current.reason || "当前资源仅供查看"}</p>}
    <label className="settings-editor-label" htmlFor={editorId}>{current.kind === "tool" ? "工具 Schema" : "文件内容"}</label>
    <textarea id={editorId} className="settings-code-editor" value={draft} onChange={event => { setDraft(event.target.value); setSaved(false); }} readOnly={!current.editable} disabled={busy} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
    {error && <div role="alert" className="settings-error">{error}{onReload && <button type="button" className="text-button" disabled={busy} onClick={() => void reread()}>读取最新内容</button>}</div>}
    {comparison && <div className="settings-comparison"><p className="settings-note">最新内容已读取，草稿已保留。核对下方服务器内容后，再保存你的修改。</p><details open><summary>服务器当前内容 · {comparison.revision}</summary><pre>{comparison.content}</pre></details></div>}
    <footer className="settings-editor-actions"><span role="status">{reading ? "正在读取…" : saving ? "正在保存…" : saved ? <><Check size={14} aria-hidden="true" />已保存</> : dirty ? "有未保存的修改" : ""}</span>{current.editable && <><button type="button" className="ui-button ghost" disabled={!dirty || busy} onClick={() => { setDraft(current.content); setError(null); }}><RotateCcw size={15} aria-hidden="true" />撤销修改</button><button type="button" className="ui-button primary" disabled={!dirty || busy} onClick={() => void save()}><Save size={15} aria-hidden="true" />保存</button></>}</footer>
  </div>;
}
