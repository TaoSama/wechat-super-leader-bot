import { useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ScopedSession } from "../../../types";
import { cancelPlan, createPlan, type AuthorizationReceipt } from "../../../api/authorizations";
import { authorizableSessions, emptyPlanStep, MAX_PLAN_STEPS, parseSessionKey, removePlanStep, sessionDisplay, sessionKey, sessionLabel, validatePlanDraft,
  type DraftErrors, type PlanDraft, type PlanStepDraft } from "../authorization-forms";
import { useAuthorizationSubmit } from "../useAuthorizationSubmit";

interface Props {
  sessions: ScopedSession[];
  initial?: PlanDraft;
  /** Active plan to cancel before creating the replacement. */
  replacingId?: string;
  truncatedSteps?: number[];
  onDone: (receipt: AuthorizationReceipt) => void;
  onClose: () => void;
}

export function SessionSelect({ id, value, sessions, onChange, label }: { id: string; value: string; sessions: ScopedSession[]; onChange: (value: string) => void; label: string }) {
  const known = sessions.some(session => sessionKey({ nodeId: session.nodeId, sessionId: session.id }) === value);
  return <select id={id} aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
    <option value="">选择会话</option>
    {value && !known && <option value={value}>{sessionDisplay(parseSessionKey(value))}（当前不可派发）</option>}
    {sessions.map(session => { const key = sessionKey({ nodeId: session.nodeId, sessionId: session.id });
      return <option key={key} value={key}>{sessionLabel(session)}</option>; })}
  </select>;
}

function toggle(values: number[], value: number, on: boolean): number[] {
  return on ? [...new Set([...values, value])].sort((a, b) => a - b) : values.filter(item => item !== value);
}

export function PlanForm({ sessions, initial, replacingId, truncatedSteps = [], onDone, onClose }: Props) {
  const eligible = useMemo(() => authorizableSessions(sessions), [sessions]);
  const [draft, setDraft] = useState<PlanDraft>(initial ?? { steps: [emptyPlanStep()] });
  const [errors, setErrors] = useState<DraftErrors>({});
  const submit = useAuthorizationSubmit();
  const editing = replacingId !== undefined;

  function update(next: PlanDraft) { setDraft(next); setErrors({}); submit.resetKey(); }
  function updateStep(index: number, patch: Partial<PlanStepDraft>) {
    update({ steps: draft.steps.map((step, position) => {
      if (position !== index) return step;
      const merged = { ...step, ...patch };
      return { ...merged, resultFrom: merged.resultFrom.filter(source => merged.dependsOn.includes(source)) };
    }) });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validatePlanDraft(draft, eligible);
    for (const number of truncatedSteps) {
      if (initial && draft.steps[number - 1] && draft.steps[number - 1].prompt === initial.steps[number - 1]?.prompt) {
        found[`steps.${number - 1}.prompt`] = `步骤 ${number} 的任务摘要已截断，请补全或改写后再提交。`;
      }
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    const receipt = await submit.runReplacing(replacingId, cancelPlan, (requestId, signal) => createPlan(draft, requestId, signal));
    if (receipt) onDone(receipt);
  }

  const { replaced } = submit;
  const failure = submit.error && (replaced ? `原计划已取消，但新计划未创建：${submit.error}` : submit.error);
  return <form className="authorization-form" aria-label={editing ? "修改计划" : "新建计划"} onSubmit={event => void onSubmit(event)} noValidate>
    <h3>{editing ? "修改计划（取消后重建）" : "新建计划"}</h3>
    <p className="section-description">{editing
      ? "已授权的计划不能直接修改。提交后会先取消原计划的后续派发，再按下方内容创建新计划；原会话已在执行的任务不会停止。"
      : `最多 ${MAX_PLAN_STEPS} 步。提交即代表你在本聊天中确认授权，服务端会按微信计划同样的规则校验并冻结会话路线。`}</p>
    {truncatedSteps.length > 0 && <p className="execution-caution" role="note">步骤 {truncatedSteps.join("、")} 的任务摘要已截断，请补全后再提交。</p>}
    {!eligible.length && <p className="execution-caution" role="note">当前没有可派发的已发现会话。</p>}
    <ol className="authorization-steps">{draft.steps.map((step, index) => {
      const number = index + 1, prefix = `plan-step-${number}`;
      return <li key={index} className="authorization-step">
        <div className="authorization-step-heading"><strong>步骤 {number}</strong>
          {draft.steps.length > 1 && <button type="button" className="ui-button ghost" aria-label={`删除步骤 ${number}`} onClick={() => update(removePlanStep(draft, index))}><Trash2 size={14} aria-hidden="true" /></button>}
        </div>
        <label htmlFor={`${prefix}-session`}>会话</label>
        <SessionSelect id={`${prefix}-session`} label={`步骤 ${number} 的会话`} value={step.nodeId ? sessionKey(step) : ""} sessions={eligible}
          onChange={value => updateStep(index, value ? parseSessionKey(value) : { nodeId: "", sessionId: "" })} />
        {errors[`steps.${index}.session`] && <p role="alert" className="command-error">{errors[`steps.${index}.session`]}</p>}
        <label htmlFor={`${prefix}-prompt`}>任务</label>
        <textarea id={`${prefix}-prompt`} value={step.prompt} rows={3} onChange={event => updateStep(index, { prompt: event.target.value })} />
        {errors[`steps.${index}.prompt`] && <p role="alert" className="command-error">{errors[`steps.${index}.prompt`]}</p>}
        {index > 0 && <fieldset><legend>依赖步骤（仅精确完成才解锁）</legend>
          {Array.from({ length: index }, (_, earlier) => earlier + 1).map(dependency => <label key={dependency} className="authorization-check">
            <input type="checkbox" checked={step.dependsOn.includes(dependency)} onChange={event => updateStep(index, { dependsOn: toggle(step.dependsOn, dependency, event.target.checked) })} />
            依赖步骤 {dependency}</label>)}
        </fieldset>}
        {step.dependsOn.length > 0 && <fieldset><legend>使用结果（来自直接依赖）</legend>
          {step.dependsOn.map(source => <label key={source} className="authorization-check">
            <input type="checkbox" checked={step.resultFrom.includes(source)} onChange={event => updateStep(index, { resultFrom: toggle(step.resultFrom, source, event.target.checked) })} />
            使用步骤 {source} 的结果</label>)}
        </fieldset>}
        {errors[`steps.${index}.dependsOn`] && <p role="alert" className="command-error">{errors[`steps.${index}.dependsOn`]}</p>}
        {errors[`steps.${index}.resultFrom`] && <p role="alert" className="command-error">{errors[`steps.${index}.resultFrom`]}</p>}
      </li>;
    })}</ol>
    {errors.steps && <p role="alert" className="command-error">{errors.steps}</p>}
    {draft.steps.length < MAX_PLAN_STEPS && <button type="button" className="ui-button secondary" onClick={() => update({ steps: [...draft.steps, emptyPlanStep()] })}><Plus size={14} aria-hidden="true" />添加步骤</button>}
    {failure && <p role="alert" className="command-error">{failure}</p>}
    <div className="authorization-actions">
      <button type="button" className="ui-button ghost" disabled={submit.busy} onClick={onClose}>放弃</button>
      <button type="submit" className="ui-button primary" disabled={submit.busy} aria-busy={submit.busy}>{submit.busy ? "正在提交…" : editing && !replaced ? "取消原计划并创建" : "确认并创建计划"}</button>
    </div>
  </form>;
}
