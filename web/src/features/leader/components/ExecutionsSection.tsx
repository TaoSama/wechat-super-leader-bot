import { ArrowUpRight, ChevronDown, ListChecks } from "lucide-react";
import type { ConsoleExecution, ConsoleExecutionStep, ConsoleExecutions, ScopedSession } from "../../../types";
import { formatTimestamp } from "../../../format";

interface Props {
  executions: ConsoleExecutions;
  sessions: ScopedSession[];
  selectedNodeId: string | null;
  schedulerEnabled: boolean;
  onOpenSession: (session: ScopedSession) => void;
}
const PLAN_LABELS = { active: "自动推进中", completed: "计划已完成", failed: "已停止 · 失败", cancelled: "已取消后续", expired: "授权已过期" };
const STEP_LABELS = { waiting: "等待派发", claimed: "已领取 · 回执待核对", queued: "已排队 · 尚未发送", pending: "等待响应", accepted: "已受理 · 尚未完成",
  completed: "精确完成", failed: "失败", uncertain: "结果存疑", cancelled: "后续已取消", expired: "授权已过期" };
const time = (value: number) => formatTimestamp(new Date(value).toISOString());

function pauseReason(plan: ConsoleExecution, observedAt: number): string | null {
  if (plan.status === "cancelled") return "已取消后续派发；已领取项可能已发送，不会停止原会话已有任务。";
  if (plan.status === "expired" || plan.status === "active" && plan.expiresAt <= observedAt) return "自动推进授权已过期，不再派发后续；已有任务仍按原回执核验。";
  if (plan.status === "failed" || plan.steps.some(step => step.status === "failed")) return "计划存在失败，已停止后续派发；已运行项仍按真实回执展示。";
  if (plan.steps.some(step => step.status === "uncertain")) return "结果存疑，整个计划暂停后续推进；先核验原回执，请勿重发。";
  return null;
}
function stepDescription(step: ConsoleExecutionStep, plan: ConsoleExecution, paused: string | null, schedulerEnabled: boolean): string {
  if (step.status === "waiting") {
    if (paused) return paused;
    const waitingFor = step.dependsOn.filter(dependency => plan.steps[dependency - 1].status !== "completed");
    if (waitingFor.length) return `等待步骤 ${waitingFor.join("、")} 的精确完成回执。`;
    return schedulerEnabled ? "等待调度检查固定目标的发送资格；具体原因未报告。" : "调度未启用，等待后续派发；已有回执保持原状态。";
  }
  return { claimed: "已领取项可能已发送，尚无可确认的命令回执。", queued: "请求已持久保存，等待会话空闲或机器上线；尚未发送。", pending: "等待宿主响应，尚未完成。",
    accepted: "输入已被受理，执行结果尚未确认。", completed: "已收到该步骤的精确完成回执。",
    failed: "本步骤失败，后续派发已停止。", uncertain: "结果不明，先核验原回执，请勿重发。",
    cancelled: "未领取的后续已取消；不会停止原会话已有任务。", expired: "后续派发授权已过期。" }[step.status];
}

function ResultSources({ step }: { step: ConsoleExecutionStep }) {
  if (!step.resultFrom.length) return null;
  if (!step.resultSources) return <p className="execution-input-note">将使用步骤 {step.resultFrom.join("、")} 的已记录输出；尚未冻结资料。</p>;
  return <div className="execution-input">
    <p className="execution-input-note">已冻结输入资料 · 冻结不代表已送达</p>
    <ul className="execution-source-list">{step.resultSources.map(source => <li key={source.step}>
      <span>步骤 {source.step}</span>
      <span className={source.truncated ? "execution-source-truncated" : ""}>{source.outputLength === 0 ? "已记录输出为空" : source.truncated ? `已裁剪 · 引用 ${source.excerptLength} / ${source.outputLength} 字符` : `未裁剪 · 引用 ${source.excerptLength} 字符`}</span>
    </li>)}</ul>
    <details className="execution-source-details"><summary>来源核对详情<ChevronDown size={14} aria-hidden="true" /></summary>
      <p className="execution-source-boundary">仅展示已记录输出的身份与长度，不展示正文；未裁剪不等于原会话完整结果。字符按 Unicode 码点计。</p>
      {step.resultSources.map(source => <dl className="execution-receipt" key={source.step} aria-label={`步骤 ${source.step} 的冻结来源`}>
        <div><dt>来源步骤</dt><dd>{source.step}</dd></div>
        <div><dt>命令</dt><dd>{source.commandId}</dd></div>
        <div><dt>精确 Turn</dt><dd>{source.turnId}</dd></div>
        <div><dt>记录 SHA256</dt><dd>{source.outputSHA256}</dd></div>
      </dl>)}
    </details>
  </div>;
}

export function ExecutionsSection({ executions, sessions, selectedNodeId, schedulerEnabled, onOpenSession }: Props) {
  const plans = executions.items.filter(plan => !selectedNodeId || plan.steps.some(step => step.nodeId === selectedNodeId));
  return <section className="execution-section" aria-labelledby="executions-heading">
    <div className="section-heading"><div><p className="eyebrow">CONFIRMED PLANS</p><h2 id="executions-heading">任务计划 <span>{plans.length}</span></h2></div><ListChecks size={22} aria-hidden="true" /></div>
    <p className="section-description">最多 {executions.limit} 条 · 进行中优先 · 快照 {time(executions.observedAt)}。仅展示已确认计划；确认、取消仍在发起计划的微信聊天中进行。</p>
    {executions.hasMore && <p className="execution-window" role="note">还有更多计划未显示；当前是最多 {executions.limit} 条的窗口，不是全部历史。</p>}
    {!schedulerEnabled && <p className="execution-window" role="note">调度未启用；当前模式不自动推进计划，已有回执保持原状态。</p>}
    {selectedNodeId && <p className="execution-filter-note">筛选包含 {selectedNodeId} 的计划；跨机步骤及其前驱完整保留。</p>}
    {!plans.length && <div className="empty-panel" role="status"><ListChecks size={24} aria-hidden="true" /><h3>{executions.items.length ? "当前窗口没有包含这台机器的计划" : "当前窗口没有已确认计划"}</h3><p>{executions.items.length ? "更换机器筛选查看当前窗口中的其他计划。" : "微信中确认的计划将在这里显示；待确认预览不会派发，也不列入执行进度。"}</p></div>}
    <div className="execution-list">{plans.map(plan => {
      const completed = plan.steps.filter(step => step.status === "completed").length;
      const completionUnverified = plan.status === "completed" && completed !== plan.steps.length;
      const paused = pauseReason(plan, executions.observedAt);
      const label = completionUnverified ? "回执待核查，计划待核对" :
        plan.status === "active" && plan.expiresAt <= executions.observedAt ? "授权到期，计划待核对" :
        plan.status === "active" && paused ? "推进已暂停" :
        plan.status === "active" && completed === plan.steps.length ? "步骤完成，计划待核对" :
        plan.status === "active" && !schedulerEnabled ? "调度未启用" : PLAN_LABELS[plan.status];
      return <article className={`execution-card status-${plan.status}`} key={plan.id} data-testid={`execution-${plan.id}`}>
        <details className="execution-details"><summary>
          <div className="execution-summary"><strong>已完成 {completed} / {plan.steps.length} 步</strong><span className={`status-badge status-${paused || completionUnverified ? "uncertain" : plan.status}`}>{label}</span><ChevronDown size={16} aria-hidden="true" /></div>
          <p className="execution-preview">首步：{plan.steps[0].prompt || "请求内容为空"}</p>
          <progress value={completed} max={plan.steps.length} aria-label={`计划 ${plan.id} 完成进度`} />
          <div className="execution-times"><time dateTime={new Date(plan.createdAt).toISOString()}>确认 {time(plan.createdAt)}</time><time dateTime={new Date(plan.expiresAt).toISOString()}>推进授权至 {time(plan.expiresAt)}</time></div>
          <span className="execution-expand-label">展开有序步骤与依赖</span>
        </summary>
          <div className="execution-content"><p className="execution-plan-id">计划 {plan.id}</p>
            {completionUnverified && <p className="execution-caution">持久状态与步骤回执尚未一致，不能确认计划完成；请核验原回执。</p>}
            {paused && <p className="execution-caution">{paused}</p>}
            <ol className="execution-steps">{plan.steps.map(step => {
              const session = sessions.find(item => item.nodeId === step.nodeId && item.id === step.sessionId);
              return <li key={step.step} className={`execution-step status-${step.status}`} data-testid={`execution-step-${plan.id}-${step.step}`}>
                <div className="execution-step-heading"><span className="execution-step-number">{step.step}</span><h3>步骤 {step.step}</h3><span className={`status-badge status-${step.status}`}>{STEP_LABELS[step.status]}</span></div>
                <p className="execution-dependencies">{step.dependsOn.length ? `依赖步骤 ${step.dependsOn.join("、")} · 仅精确完成才解锁` : "无前置依赖"}</p>
                <button type="button" className="execution-target" disabled={!session} onClick={() => { if (session) onOpenSession(session); }} aria-label={`打开计划步骤 ${step.step} 的会话 ${step.nodeId} / ${step.sessionId}`}>
                  {session?.title || "会话未在当前快照中"}{session && <ArrowUpRight size={14} aria-hidden="true" />}
                </button>
                <p className="execution-target-id">{step.nodeId} / {step.sessionId}{!session && " · 目标暂不可定位，不能跳转到其他会话"}</p>
                <p className="execution-prompt">{step.prompt || "请求内容为空"}</p>{step.promptTruncated && <p className="execution-truncated">请求摘要已截断，并非完整内容。</p>}
                <ResultSources step={step} />
                <p className="execution-step-description">{stepDescription(step, plan, paused, schedulerEnabled)}</p>
                {(step.commandId || step.turnId) && <dl className="execution-receipt">{step.commandId && <div><dt>指令</dt><dd>{step.commandId}</dd></div>}{step.turnId && <div><dt>精确 Turn</dt><dd>{step.turnId}</dd></div>}</dl>}
              </li>;
            })}</ol>
          </div>
        </details>
      </article>;
    })}</div>
  </section>;
}
