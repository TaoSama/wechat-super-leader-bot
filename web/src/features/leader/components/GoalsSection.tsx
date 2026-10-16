import { ArrowUpRight, ChevronDown, Focus } from "lucide-react";
import type { ConsoleGoals } from "../goal-contract";
import type { ScopedSession } from "../../../types";
import { formatTimestamp } from "../../../format";

interface Props { goals: ConsoleGoals; sessions: ScopedSession[]; selectedNodeId: string | null; schedulerEnabled: boolean; onOpenSession: (session: ScopedSession) => void }
const LABELS = { active: "持续推进中", blocked: "需要处理", completed: "模型判断条件已满足", cancelled: "后续已取消", expired: "授权已过期" };
const ACTIONS = { waiting: "等待发送资格", claimed: "已领取 · 回执待核对", pending: "等待受理", accepted: "已受理 · 尚未完成",
  completed: "精确完成", failed: "失败", uncertain: "结果存疑 · 不重发", blocked: "已暂停", cancelled: "后续已取消", expired: "授权已过期" };

export function GoalsSection({ goals, sessions, selectedNodeId, schedulerEnabled, onOpenSession }: Props) {
  const items = goals.items.filter(goal => !selectedNodeId || goal.targets.some(target => target.nodeId === selectedNodeId));
  return <section className="execution-section goal-section" aria-labelledby="goals-heading">
    <div className="section-heading"><div><p className="eyebrow">ONE GOAL · CONTINUOUS FOLLOW-THROUGH</p><h2 id="goals-heading">持续目标 <span>{items.length}</span></h2></div><Focus size={22} aria-hidden="true" /></div>
    <p className="section-description">确认一次，在授权范围内根据结果继续规划。动作完成不等于目标完成；确认与取消仍在微信中进行。</p>
    {goals.hasMore && <p className="execution-window">这里只显示最近 {goals.limit} 条，进行中优先，不是全部历史。</p>}
    {!schedulerEnabled && <p className="execution-window">调度未启用，已有记录不代表当前正在推进。</p>}
    {!items.length && <div className="empty-panel" role="status"><h3>当前窗口没有这台机器的持续目标</h3><p>更换机器筛选查看其他目标。</p></div>}
    <div className="execution-list">{items.map(goal => {
      const completionUnverified = goal.status === "completed" && goal.criteria.some(criterion => !criterion.supported);
      const expired = (goal.status === "active" || goal.status === "blocked") && goal.expiresAt <= goals.observedAt;
      const label = completionUnverified ? "完成依据待核查" : expired ? "授权到期 · 状态待核对" :
        goal.status === "active" && !schedulerEnabled ? "调度未启用" : LABELS[goal.status];
      return <article key={goal.id} className={`execution-card goal-card status-${goal.status}`} data-testid={`goal-${goal.id}`}>
        <details className="execution-details"><summary>
          <div className="execution-summary"><strong>{goal.objective}</strong><span className={`status-badge status-${completionUnverified || goal.status === "blocked" ? "uncertain" : goal.status}`}>{label}</span><ChevronDown size={16} aria-hidden="true" /></div>
          {goal.objectiveTruncated && <p className="execution-truncated">目标摘要已截断，微信确认记录保留完整授权。</p>}
          <p className="goal-reason">{goal.reason}</p>
          <div className="goal-budgets"><span>已规划动作 <strong>{goal.actions.length} / {goal.maxActions}</strong></span><span>决策轮数 <strong>{goal.decisionAttempts} / {goal.maxDecisions}</strong></span></div>
          <p className="execution-times">授权至 <time dateTime={new Date(goal.expiresAt).toISOString()}>{formatTimestamp(new Date(goal.expiresAt).toISOString())}</time></p>
          <span className="execution-expand-label">展开完成条件与动作证据</span>
        </summary><div className="execution-content">
          <p className="execution-plan-id">目标 {goal.id}</p>
          <p className="execution-caution">“条件已满足”是模型依据已记录结果作出的判断，不是独立业务验收。取消只停止后续派发，不停止原会话已有任务。</p>
          <h3 className="goal-subheading">完成条件</h3>
          <ol className="goal-criteria">{goal.criteria.map(criterion => <li key={criterion.index}><span>{criterion.text}</span><small>{criterion.supported ? `模型依据：动作 ${criterion.actions.join("、")}` : "尚未证实"}</small></li>)}</ol>
          <h3 className="goal-subheading">执行轨迹</h3>
          {!goal.actions.length && <p className="section-description">尚未产生动作，不代表已派发。</p>}
          <ol className="execution-steps">{goal.actions.map(action => {
            const target = goal.targets[action.target - 1];
            const session = sessions.find(session => session.nodeId === target.nodeId && session.id === target.sessionId);
            return <li className="execution-step" key={action.index}>
              <div className="execution-step-heading"><span className="execution-step-number">{action.index}</span><h3>动作 {action.index}</h3><span className={`status-badge status-${action.status}`}>{ACTIONS[action.status]}</span></div>
              <button type="button" className="execution-target" disabled={!session} onClick={() => { if (session) onOpenSession(session); }} aria-label={`打开目标动作 ${action.index} 的会话 ${target.nodeId} / ${target.sessionId}`}>{session?.title || "会话不在当前快照中"}{session && <ArrowUpRight size={14} aria-hidden="true" />}</button>
              <p className="execution-target-id">{target.nodeId} / {target.sessionId}</p>
              <p className="execution-prompt">{action.prompt}</p>{action.promptTruncated && <p className="execution-truncated">任务摘要已截断。</p>}
              <p className="execution-dependencies">{action.sourceActions.length ? `使用动作 ${action.sourceActions.join("、")} 的已记录结果` : "不传入先前动作的结果正文"}</p>
              {action.commandId && <dl className="execution-receipt"><div><dt>指令</dt><dd>{action.commandId}</dd></div>{action.turnId && <div><dt>精确 Turn</dt><dd>{action.turnId}</dd></div>}</dl>}
            </li>;
          })}</ol>
        </div></details>
      </article>;
    })}</div>
  </section>;
}
