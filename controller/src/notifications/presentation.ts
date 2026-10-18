import { TurnIdSchema, type CommandRecord } from "../types.js";
import { executionRequestId, matchesExecutionCommand, type ExecutionRecord } from "../leader/plans/execution.js";
import { goalRequestId, matchesGoalCommand, type GoalRecord } from "../leader/goals/goal.js";

const TITLE_LIMIT = 80;
const RESULT_LIMIT = 300;
const GOAL_RESULT_LIMIT = 3;
const TRUNCATED_OUTPUT_SUFFIX = "...(truncated)";
const STATUS_LABELS = { completed: "已完成", failed: "执行失败", blocked: "需要处理", expired: "授权已到期" } as const;
type TerminalKind = keyof typeof STATUS_LABELS;

export interface NotificationCommandReader {
  findCommandByRequestId(requestId: string): Promise<CommandRecord | null>;
}

/** Only immutable request identities from the confirmed authorization are read. */
export async function notificationCommands(reader: NotificationCommandReader, requestIds: string[]): Promise<CommandRecord[]> {
  const commands = await Promise.all(requestIds.map(id => reader.findCommandByRequestId(id)));
  return commands.filter((command): command is CommandRecord => command !== null);
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let excerpt = value.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/u.test(excerpt)) excerpt = excerpt.slice(0, -1);
  return `${excerpt}…`;
}

function title(prompt: string): string {
  const line = prompt.split(/\r?\n/u).find(value => value.trim()) ?? "任务";
  return clip(line.replace(/^[\s#>*-]+/u, "").replace(/[\p{Cc}]/gu, " ").trim() || "任务", TITLE_LIMIT);
}

function result(command: CommandRecord | undefined): string {
  if (!command || command.status !== "completed" || !TurnIdSchema.safeParse(command.turnId).success || command.inputReceipt ||
      command.sendRoute === "terminal-pane" || command.sessionId.startsWith("terminal:")) return "尚无可核对的精确完成结果。";
  const output = command.output?.trim();
  if (!output) return "已收到完成回执，未记录结果正文。";
  const truncated = output.endsWith(TRUNCATED_OUTPUT_SUFFIX);
  const recorded = truncated ? output.slice(0, -TRUNCATED_OUTPUT_SUFFIX.length).trim() : output;
  if (!recorded) return "已收到完成回执，结果记录已截断且没有可展示正文。";
  const quoted = clip(recorded, RESULT_LIMIT).split(/\r?\n/u).map(line => `> ${line}`).join("\n");
  // A persisted receipt may predate final-only extraction; quote it as recorded output, never an independent verdict.
  return `已记录输出节选${truncated ? "（原记录已截断）" : ""}：\n${clip(quoted, RESULT_LIMIT)}`;
}

function header(kind: TerminalKind, task: string): string {
  return `### ${STATUS_LABELS[kind]}\n\n**任务**：${title(task)}`;
}

export function planNotificationText(execution: ExecutionRecord, commands: readonly CommandRecord[]): string {
  const kind = execution.status as Exclude<TerminalKind, "blocked">;
  const steps = execution.plan.actions.map((action, index) => {
    const command = execution.attempts[index] && commands.find(item => matchesExecutionCommand(execution, index, item));
    return `**${index + 1}. ${title(action.prompt)}**\n${result(command || undefined)}`;
  });
  return `${header(kind, execution.plan.actions[0].prompt)}\n\n${steps.join("\n\n")}` +
    (kind === "completed" ? "" : "\n\n后续派发已停止；原会话中的任务可能仍在执行。");
}

export function goalResultNotificationText(goal: GoalRecord, commands: readonly CommandRecord[]): string {
  const kind = goal.status as Exclude<TerminalKind, "failed">;
  const recent = goal.actions.slice(-GOAL_RESULT_LIMIT);
  const results = recent.map(action => {
    const index = action.index - 1;
    const command = action.attempt && commands.find(item => matchesGoalCommand(goal, index, item));
    return `**${action.index}. ${title(action.prompt)}**\n${result(command || undefined)}`;
  });
  return `${header(kind, goal.proposal.objective)}\n\n${results.length ? results.join("\n\n") : "尚无已记录的任务结果。"}` +
    (goal.actions.length > recent.length ? `\n\n仅展示最近 ${recent.length} 项任务结果。` : "") +
    (kind === "completed" ? "\n\n完成状态基于精确回执的条件判断。" : "\n\n后续派发已停止；原会话中的任务可能仍在执行。");
}

export const planNotificationRequestIds = (execution: ExecutionRecord): string[] =>
  execution.plan.actions.flatMap((_action, index) => execution.attempts[index] ? [executionRequestId(execution, index)] : []);

export const goalNotificationRequestIds = (goal: GoalRecord): string[] =>
  goal.actions.slice(-GOAL_RESULT_LIMIT).flatMap(action => action.attempt ? [goalRequestId(goal, action.index - 1)] : []);
