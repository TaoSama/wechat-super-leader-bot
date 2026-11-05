import { useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ScopedSession } from "../../../types";
import { cancelGoal, createGoal, type AuthorizationReceipt } from "../../../api/authorizations";
import { authorizableSessions, emptyGoalDraft, MAX_CRITERION, MAX_GOAL_ACTIONS, MAX_GOAL_CRITERIA, MAX_GOAL_DECISIONS, MAX_GOAL_MINUTES,
  MAX_GOAL_TARGETS, parseSessionKey, sessionDisplay, sessionKey, sessionLabel, validateGoalDraft, type DraftErrors, type GoalDraft } from "../authorization-forms";
import { useAuthorizationSubmit } from "../useAuthorizationSubmit";

interface Props {
  sessions: ScopedSession[];
  initial?: GoalDraft;
  /** Open goal to cancel before creating the replacement. */
  replacingId?: string;
  objectiveTruncated?: boolean;
  onDone: (receipt: AuthorizationReceipt) => void;
  onClose: () => void;
}

export function GoalForm({ sessions, initial, replacingId, objectiveTruncated = false, onDone, onClose }: Props) {
  const eligible = useMemo(() => authorizableSessions(sessions), [sessions]);
  const [draft, setDraft] = useState<GoalDraft>(initial ?? emptyGoalDraft());
  const [errors, setErrors] = useState<DraftErrors>({});
  const submit = useAuthorizationSubmit();
  const editing = replacingId !== undefined;
  // Known targets outside the current eligible list stay visible so the user can see and clear them.
  const choices = [...eligible.map(session => ({ key: sessionKey({ nodeId: session.nodeId, sessionId: session.id }), label: sessionLabel(session), eligible: true })),
    ...draft.targets.filter(target => !eligible.some(session => session.nodeId === target.nodeId && session.id === target.sessionId))
      .map(target => ({ key: sessionKey(target), label: `${sessionDisplay(target)}（当前不可派发）`, eligible: false }))];

  function update(patch: Partial<GoalDraft>) { setDraft(current => ({ ...current, ...patch })); setErrors({}); submit.resetKey(); }
  function toggleTarget(key: string, on: boolean) {
    update({ targets: on ? [...draft.targets, parseSessionKey(key)] : draft.targets.filter(item => sessionKey(item) !== key) });
  }
  const number = (value: string) => value.trim() === "" ? Number.NaN : Number(value);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validateGoalDraft(draft, eligible);
    if (objectiveTruncated && initial && draft.objective === initial.objective) found.objective = "目标摘要已截断，请补全或改写后再提交。";
    setErrors(found);
    if (Object.keys(found).length) return;
    const receipt = await submit.runReplacing(replacingId, cancelGoal, (requestId, signal) => createGoal(draft, requestId, signal));
    if (receipt) onDone(receipt);
  }

  const { replaced } = submit;
  const failure = submit.error && (replaced ? `原目标已取消，但新目标未创建：${submit.error}` : submit.error);
  return <form className="authorization-form" aria-label={editing ? "修改持续目标" : "新建持续目标"} onSubmit={event => void onSubmit(event)} noValidate>
    <h3>{editing ? "修改持续目标（取消后重建）" : "新建持续目标"}</h3>
    <p className="section-description">{editing
      ? "已授权的目标不能直接修改。提交后会先取消原目标的后续派发，再按下方内容创建新目标；原会话当前动作不会停止。约束不在控制台展示，请重新填写。"
      : "提交即代表你在本聊天中确认授权。同一聊天同时只能有一个未结束目标，且有进行中计划时不能创建目标。"}</p>
    <label htmlFor="goal-objective">目标</label>
    <textarea id="goal-objective" rows={3} value={draft.objective} onChange={event => update({ objective: event.target.value })} />
    {errors.objective && <p role="alert" className="command-error">{errors.objective}</p>}
    <fieldset><legend>完成条件（最多 {MAX_GOAL_CRITERIA} 条，每条最多 {MAX_CRITERION} 字）</legend>
      {draft.criteria.map((criterion, index) => <div key={index} className="authorization-row">
        <input aria-label={`完成条件 ${index + 1}`} value={criterion} onChange={event => update({ criteria: draft.criteria.map((item, position) => position === index ? event.target.value : item) })} />
        {draft.criteria.length > 1 && <button type="button" className="ui-button ghost" aria-label={`删除完成条件 ${index + 1}`} onClick={() => update({ criteria: draft.criteria.filter((_, position) => position !== index) })}><Trash2 size={14} aria-hidden="true" /></button>}
      </div>)}
      {draft.criteria.length < MAX_GOAL_CRITERIA && <button type="button" className="ui-button secondary" onClick={() => update({ criteria: [...draft.criteria, ""] })}><Plus size={14} aria-hidden="true" />添加条件</button>}
    </fieldset>
    {errors.criteria && <p role="alert" className="command-error">{errors.criteria}</p>}
    <fieldset><legend>授权会话（最多 {MAX_GOAL_TARGETS} 个）</legend>
      {!choices.length && <p className="section-description">当前没有可派发的已发现会话。</p>}
      {choices.map(choice => <label key={choice.key} className="authorization-check">
        <input type="checkbox" checked={draft.targets.some(target => sessionKey(target) === choice.key)} onChange={event => toggleTarget(choice.key, event.target.checked)} />
        {choice.label}</label>)}
    </fieldset>
    {errors.targets && <p role="alert" className="command-error">{errors.targets}</p>}
    <label htmlFor="goal-constraints">约束（可选）</label>
    <textarea id="goal-constraints" rows={2} value={draft.constraints} onChange={event => update({ constraints: event.target.value })} />
    {errors.constraints && <p role="alert" className="command-error">{errors.constraints}</p>}
    <div className="authorization-budgets">
      <label>动作预算<input type="number" min={1} max={MAX_GOAL_ACTIONS} value={Number.isNaN(draft.maxActions) ? "" : draft.maxActions} onChange={event => update({ maxActions: number(event.target.value) })} /></label>
      <label>决策预算<input type="number" min={1} max={MAX_GOAL_DECISIONS} value={Number.isNaN(draft.maxDecisions) ? "" : draft.maxDecisions} onChange={event => update({ maxDecisions: number(event.target.value) })} /></label>
      <label>时长（分钟）<input type="number" min={1} max={MAX_GOAL_MINUTES} value={Number.isNaN(draft.durationMinutes) ? "" : draft.durationMinutes} onChange={event => update({ durationMinutes: number(event.target.value) })} /></label>
    </div>
    {["maxActions", "maxDecisions", "durationMinutes"].map(field => errors[field] && <p key={field} role="alert" className="command-error">{errors[field]}</p>)}
    {failure && <p role="alert" className="command-error">{failure}</p>}
    <div className="authorization-actions">
      <button type="button" className="ui-button ghost" disabled={submit.busy} onClick={onClose}>放弃</button>
      <button type="submit" className="ui-button primary" disabled={submit.busy} aria-busy={submit.busy}>{submit.busy ? "正在提交…" : editing && !replaced ? "取消原目标并创建" : "确认并创建目标"}</button>
    </div>
  </form>;
}
