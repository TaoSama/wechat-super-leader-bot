import { createHash } from "node:crypto";
import { CommandError, type CommandService } from "../../commands/service.js";
import { ConflictError, type IStore } from "../../store/interface.js";
import { LeaderDataSchema, type LeaderData, type LeaderReply, type Plan } from "../contracts.js";
import { hasTerminalTarget } from "./execution.js";

export const TERMINAL_INPUT_WARNING = "原终端输入 · 非原子：CLI 退出、同类进程替换或人工输入可能与投递竞态。输入已写入不表示 Agent 已开始、成功或完成；不自动重发，也不解锁依赖。";

export function assertTerminalSingleStep(plan: Pick<Plan, "actions">): void {
  if (hasTerminalTarget(plan) && (plan.actions.length !== 1 || plan.actions[0].dependsOn.length !== 0 || (plan.actions[0].resultFrom?.length ?? 0) !== 0)) {
    throw new CommandError(409, "终端输入无法证明任务完成，只支持独立单步，不能加入多步或依赖计划");
  }
}

export function terminalPlanRequestId(chatId: string, planId: string): string {
  return `leader_terminal_${createHash("sha256").update(JSON.stringify([chatId, planId])).digest("hex")}`;
}

export async function submitTerminalPlan(store: IStore, commands: Pick<CommandService, "submit">,
  chatId: string, revision: number, plan: Plan, data: LeaderData, now: () => number): Promise<LeaderReply> {
  assertTerminalSingleStep(plan);
  const action = plan.actions[0];
  const claim = data.inflight;
  if (!claim || action.sendRoute !== "terminal-pane") throw new CommandError(409, "终端输入授权或路线无效");
  try {
    const command = await commands.submit({ nodeId: action.nodeId, sessionId: action.sessionId,
      prompt: action.prompt, skills: action.skills, action: "send", requestId: terminalPlanRequestId(chatId, plan.id) },
    5000, async () => {
      const active = await store.getLatestExecution(chatId);
      const current = await store.getLeaderState(chatId);
      const inflight = current && LeaderDataSchema.parse(current.data).inflight;
      if (active?.status === "active" || current?.revision !== revision || !inflight ||
          inflight.messageId !== claim.messageId || inflight.inputHash !== claim.inputHash ||
          inflight.expiresAt <= now() || plan.expiresAt <= now() || JSON.stringify(inflight.plan) !== JSON.stringify(plan)) {
        throw new CommandError(409, "终端输入确认所有权或时限已失效");
      }
    }, "terminal-pane");
    data.commandIds.push(command.commandId);
    const status = command.status === "input-written" ? "输入已写入，执行未确认" :
      command.status === "failed" ? "终端输入投递失败，未确认执行" : "终端输入投递结果待核查，执行未确认";
    return { text: `${status}。\n${TERMINAL_INPUT_WARNING}\n指令：${command.commandId}`, commandId: command.commandId };
  } catch (error) {
    if (error instanceof CommandError || error instanceof ConflictError) {
      return { text: `终端输入未确认执行，请核查已有指令；不会自动重发。\n${TERMINAL_INPUT_WARNING}` };
    }
    throw error;
  }
}
