import { ChevronRight, FileText, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiAuthError } from "../../api/errors";
import { loadResource, loadResources, saveResource } from "../../api/settings";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { ResourceEditor, type EditableResource } from "./ResourceEditor";
import type { Diagnostic, ResourceDocument, SettingsChat, SettingsResource } from "./contract";

interface Props { memory?: boolean; chats: SettingsChat[]; onAuthFailure: () => void }
const editable = (item: ResourceDocument): EditableResource => item;
export function ResourcesSection({ memory = false, chats, onAuthFailure }: Props) {
  const [chatId, setChatId] = useState(memory ? chats[0]?.chatId ?? "" : "");
  const [resources, setResources] = useState<SettingsResource[]>([]);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<ResourceDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scopeChat = chatId || undefined;
  const visibleResources = resources.filter(item => (kind === "all" || item.kind === kind) && `${item.title} ${item.path}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const directories = visibleResources.reduce((groups, item) => { const label = item.kind === "prompt" ? "系统提示" : item.kind === "skill" ? "技能" : "工具"; const directory = memory ? "" : `${label}${item.path.includes("/") ? ` · ${item.path.slice(0, item.path.lastIndexOf("/"))}` : ""}`; groups.set(directory, [...(groups.get(directory) ?? []), item]); return groups; }, new Map<string, SettingsResource[]>());
  function fail(reason: unknown) { if (reason instanceof ApiAuthError) onAuthFailure(); else setError(reason instanceof Error ? reason.message : "资源读取失败"); }
  function guard(action: () => void) { if (dirty) setPendingAction(() => action); else action(); }
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  useEffect(() => {
    if (memory && !chatId) return;
    const abort = new AbortController();
    setLoading(true); setError(null); setDiagnostics([]); setResources([]); setSelected(null); setSelectedId(null); setDirty(false);
    void loadResources(scopeChat, abort.signal).then(index => { if (!abort.signal.aborted) { setResources(index.resources.filter(item => memory ? item.kind === "memory" : item.kind !== "memory")); setDiagnostics(index.diagnostics); } }).catch(reason => { if (!abort.signal.aborted) fail(reason); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [scopeChat, memory, revision]);
  useEffect(() => {
    if (!selectedId) return;
    const abort = new AbortController();
    setLoading(true); setError(null); setSelected(null); setDirty(false);
    void loadResource(selectedId, scopeChat, abort.signal).then(item => { if (!abort.signal.aborted) { setSelected(item); setDirty(false); } }).catch(reason => { if (!abort.signal.aborted) fail(reason); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selectedId, scopeChat]);
  async function save(_current: EditableResource, content: string) {
    if (!selected) throw new Error("请先选择资源");
    try {
      const next = await saveResource({ ...selected, revision: _current.revision }, content, scopeChat);
      setSelected(next); setResources(items => items.map(item => item.id === next.id ? next : item)); setDirty(false);
      return editable(next);
    } catch (reason) { if (reason instanceof ApiAuthError) onAuthFailure(); throw reason; }
  }
  async function reread() {
    if (!selected) throw new Error("请先选择资源");
    try { const latest = await loadResource(selected.id, scopeChat); setSelected(latest); return editable(latest); }
    catch (reason) { if (reason instanceof ApiAuthError) onAuthFailure(); throw reason; }
  }
  return <section className="settings-section">
    <div className="settings-section-heading"><h3>{memory ? "记忆与偏好" : "运行资源"}</h3><button type="button" className="text-button" disabled={loading || saving} onClick={() => guard(() => setRevision(value => value + 1))}><RefreshCw size={14} aria-hidden="true" />重新读取</button></div>
    <p className="settings-description">{memory ? "Task 记录当前任务，Memory 记录长期事实，Preference 记录回复与通知习惯。也可以直接在微信中用自然语言告诉助手。" : "查看和编辑实际使用的系统提示、技能文件与工具 Schema。每项资源显示作用范围、版本和生效方式。"}</p>
    <label className="settings-field settings-chat-field"><span>{memory ? "微信会话" : "作用对象"}</span><select value={chatId} onChange={event => { const next = event.target.value; guard(() => { setChatId(next); setSelectedId(null); setSelected(null); }); }} disabled={loading || saving}>{!memory && <option value="">实例资源</option>}{chats.map(chat => <option key={chat.chatId} value={chat.chatId}>{chat.label}</option>)}{memory && !chats.length && <option value="">暂无微信会话</option>}</select></label>
    {chats.find(chat => chat.chatId === chatId)?.threadId && <p className="settings-description">Codex Task：<code>{chats.find(chat => chat.chatId === chatId)?.threadId}</code></p>}
    {!memory && resources.length > 0 && <div className="settings-resource-filters"><label className="settings-field"><span>资源类型</span><select value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部</option><option value="prompt">系统提示</option><option value="skill">技能</option><option value="tool">工具</option></select></label><label className="settings-field"><span>筛选资源</span><input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="名称或文件路径" /></label></div>}
    {loading && <p role="status" className="settings-description">正在读取…</p>}
    {diagnostics.map(item => <p key={item.id} role={item.status === "error" ? "alert" : "status"} className={item.status === "ok" ? "settings-description" : "settings-error"}>{item.label}：{item.value}</p>)}
    {error && <p role="alert" className="settings-error">{error}</p>}
    {!loading && resources.length === 0 && !error && <p className="settings-note">{memory && !chatId ? "当前没有可管理的微信会话。" : "当前没有可查看的资源。"}</p>}
    {!loading && resources.length > 0 && visibleResources.length === 0 && <p className="settings-description">没有匹配的资源。</p>}
    <div className="settings-resource-list" aria-label={memory ? "记忆文件" : "运行资源文件"}>{[...directories].map(([directory, items]) => <details key={directory} className="settings-resource-directory" open={memory || !directory.startsWith("技能")}><summary>{directory || "记忆文件"}<small>{items.length}</small></summary>{items.map(item => <button key={item.id} type="button" aria-pressed={item.id === selectedId} disabled={loading || saving} onClick={() => { if (item.id !== selectedId) guard(() => setSelectedId(item.id)); }}><FileText size={16} aria-hidden="true" /><span>{item.title}<small>{item.path || item.scope}</small></span><ChevronRight size={15} aria-hidden="true" /></button>)}</details>)}</div>
    {selected && !loading && <ResourceEditor key={`${scopeChat || "instance"}:${selected.id}`} resource={editable(selected)} onSave={save} onReload={reread} onDirtyChange={setDirty} onSavingChange={setSaving} />}
    {pendingAction && <ConfirmDialog title="放弃未保存的修改？" description="当前草稿尚未保存，继续会丢弃这些修改。" confirmLabel="放弃修改" onClose={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); setDirty(false); action(); }} />}
  </section>;
}
