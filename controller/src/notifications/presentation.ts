import { TurnIdSchema, type CommandRecord } from "../types.js";
import { executionRequestId, matchesExecutionCommand, type ExecutionRecord } from "../leader/plans/execution.js";
import { goalRequestId, matchesGoalCommand, type GoalRecord } from "../leader/goals/goal.js";

const TITLE_LIMIT = 80;
const TRUNCATED_OUTPUT_SUFFIX = "...(truncated)";
const STATUS_LABELS = { completed: "已完成", failed: "执行失败", blocked: "需要处理", expired: "授权已到期" } as const;
const COMMAND_FAILURE_LABELS = { failed: "命令执行失败", cancelled: "命令已取消", expired: "命令授权已到期" } as const;
type TerminalKind = keyof typeof STATUS_LABELS;

export interface NotificationCommandReader {
  findCommandByRequestId(requestId: string): Promise<CommandRecord | null>;
}

/** Only immutable request identities from the confirmed authorization are read. */
export async function notificationCommands(reader: NotificationCommandReader, requestIds: string[]): Promise<CommandRecord[]> {
  const commands: CommandRecord[] = [];
  for (const id of requestIds) {
    const command = await reader.findCommandByRequestId(id);
    if (command) commands.push(command);
  }
  return commands;
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let excerpt = value.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/u.test(excerpt)) excerpt = excerpt.slice(0, -1);
  return `${excerpt}…`;
}

export function notificationTaskTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/u).find(value => value.trim()) ?? "任务";
  return clip(line.replace(/^[\s#>*-]+/u, "").replace(/[\p{Cc}]/gu, " ").trim() || "任务", TITLE_LIMIT);
}

function* resultChunks(command: CommandRecord | undefined): Generator<string> {
  if (command && command.status in COMMAND_FAILURE_LABELS) {
    const label = COMMAND_FAILURE_LABELS[command.status as keyof typeof COMMAND_FAILURE_LABELS];
    if (command.error?.trim()) { yield `${label}。\n\n`; yield command.error; }
    else yield `${label}，未记录错误正文。`;
    return;
  }
  if (!command || command.status !== "completed" || !TurnIdSchema.safeParse(command.turnId).success || command.inputReceipt ||
      command.sendRoute === "terminal-pane" || command.sessionId.startsWith("terminal:")) { yield "尚无可核对的精确完成结果。"; return; }
  const output = command.output;
  if (!output?.trim()) { yield "已收到完成回执，未记录结果正文。"; return; }
  const truncated = output.endsWith(TRUNCATED_OUTPUT_SUFFIX);
  // Preserve the exact recorded Markdown, including old receipts that were truncated upstream.
  if (truncated) yield "原记录已截断，以下为完整已记录正文：\n\n";
  yield output;
}

function header(kind: TerminalKind, task: string): string {
  return `### ${STATUS_LABELS[kind]}\n\n**任务**：${notificationTaskTitle(task)}`;
}

export function planNotificationText(execution: ExecutionRecord, commands: readonly CommandRecord[]): string {
  return [...planNotificationChunks(execution, commands)].join("");
}

export function* planNotificationChunks(execution: ExecutionRecord, commands: readonly CommandRecord[]): Generator<string> {
  const kind = execution.status as Exclude<TerminalKind, "blocked">;
  yield `${header(kind, execution.plan.actions[0].prompt)}\n\n`;
  for (const [index, action] of execution.plan.actions.entries()) {
    if (index) yield "\n\n";
    const command = execution.attempts[index] && commands.find(item => matchesExecutionCommand(execution, index, item));
    if (execution.plan.actions.length !== 1) yield `**${index + 1}. ${notificationTaskTitle(action.prompt)}**\n\n`;
    yield* resultChunks(command || undefined);
  }
  if (kind !== "completed") yield "\n\n后续派发已停止；原会话中的任务可能仍在执行。";
}

export function goalResultNotificationText(goal: GoalRecord, commands: readonly CommandRecord[]): string {
  return [...goalResultNotificationChunks(goal, commands)].join("");
}

export function* goalResultNotificationChunks(goal: GoalRecord, commands: readonly CommandRecord[]): Generator<string> {
  const kind = goal.status as Exclude<TerminalKind, "failed">;
  yield `${header(kind, goal.proposal.objective)}\n\n`;
  for (const [position, action] of goal.actions.entries()) {
    if (position) yield "\n\n";
    const index = action.index - 1;
    const command = action.attempt && commands.find(item => matchesGoalCommand(goal, index, item));
    yield `**${action.index}. ${notificationTaskTitle(action.prompt)}**\n\n`;
    yield* resultChunks(command || undefined);
  }
  if (!goal.actions.length) yield "尚无已记录的任务结果。";
  yield kind === "completed" ? "\n\n完成状态基于精确回执的条件判断。" : "\n\n后续派发已停止；原会话中的任务可能仍在执行。";
}

export const planNotificationRequestIds = (execution: ExecutionRecord): string[] =>
  execution.plan.actions.flatMap((_action, index) => execution.attempts[index] ? [executionRequestId(execution, index)] : []);

export const goalNotificationRequestIds = (goal: GoalRecord): string[] =>
  goal.actions.flatMap(action => action.attempt ? [goalRequestId(goal, action.index - 1)] : []);
