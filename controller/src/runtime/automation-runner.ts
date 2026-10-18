import { createHash } from "node:crypto";
import type { AutomationRunner, AutomationRun, RunnerOutcome, Schedule } from "../automations/contracts.js";
import { CommandError, type CommandService } from "../commands/service.js";
import type { IStore } from "../store/interface.js";
import { TurnIdSchema, type CommandRecord } from "../types.js";

const requestId = (run: AutomationRun) => `automation:${run.id}`;

/** Reuses the command ledger and its precise completion receipts, including queued sends. */
export function createAutomationRunner(store: IStore, commands: Pick<CommandService, "submit">,
  isAllowed: (chatId: string) => boolean, isActive: (schedule: Schedule) => Promise<boolean>): AutomationRunner {
  const inspectCommand = (command: CommandRecord, run: AutomationRun, schedule: Schedule): RunnerOutcome => {
    if (schedule.kind !== "session" || !schedule.target || command.requestId !== requestId(run) ||
      command.nodeId !== schedule.target.nodeId || command.sessionId !== schedule.target.sessionId ||
      command.sendRoute !== schedule.target.sendRoute || command.action !== "send" || command.prompt !== schedule.prompt ||
      command.authority?.type !== "automation" || command.authority.chatId !== schedule.chatId ||
      command.authority.scheduleId !== schedule.id || command.authority.runId !== run.id) {
      return { status: "unknown", error: "Scheduled command identity does not match its frozen authorization" };
    }
    if (command.status === "completed") {
      if (!TurnIdSchema.safeParse(command.turnId).success || command.inputReceipt) {
        return { status: "unknown", error: "No precise task completion receipt" };
      }
      const text = command.output?.trim() ? command.output : "已收到本次任务的完成回执，未记录结果正文。";
      return { status: "completed", result: { text,
        fingerprint: createHash("sha256").update(text).digest("hex"), meaningful: Boolean(text.trim()) } };
    }
    if (["failed", "expired", "cancelled"].includes(command.status)) {
      return { status: "failed", result: { text: command.error || "本次定时任务未能完成，请查看任务记录。", error: command.status } };
    }
    if (command.status === "uncertain") return { status: "unknown", error: "Scheduled command delivery is uncertain; automatic redispatch is disabled" };
    return { status: "running", commandId: command.commandId };
  };
  return {
    async start(run, schedule) {
      if (schedule.kind !== "session" || !schedule.target || !isAllowed(schedule.chatId) || !await isActive(schedule)) {
        return { status: "failed", result: { text: "任务的定时授权已停止，本次未派发。", error: "schedule_not_active" } };
      }
      try {
        const command = await commands.submit({ nodeId: schedule.target.nodeId, sessionId: schedule.target.sessionId, action: "send", prompt: schedule.prompt,
          requestId: requestId(run) }, 0, async () => {
          if (!isAllowed(schedule.chatId) || !await isActive(schedule)) throw new CommandError(409, "Scheduled authorization is no longer active");
        }, schedule.target.sendRoute, { type: "automation", chatId: schedule.chatId, scheduleId: schedule.id, runId: run.id });
        return inspectCommand(command, run, schedule);
      } catch (error) {
        // A saved request always wins over a local exception, including an ambiguous submit response.
        const existing = await store.findCommandByRequestId(requestId(run));
        if (existing) return inspectCommand(existing, run, schedule);
        if (error instanceof CommandError) return { status: "failed", result: { text: "定时任务未派发，请检查目标会话和任务状态。", error: "dispatch_rejected" } };
        throw error;
      }
    },
    async inspect(run, schedule) {
      const command = run.commandId ? await store.getCommand(run.commandId) : await store.findCommandByRequestId(requestId(run));
      return command ? inspectCommand(command, run, schedule) : { status: "unknown", error: "Scheduled command record is unavailable" };
    },
  };
}
