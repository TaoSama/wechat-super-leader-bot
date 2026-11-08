import { z } from "zod";
import type { ModelTool } from "../leader/model/contracts.js";
import { CreateScheduleSchema, UpdateBackgroundPromptSchema } from "./contracts.js";
import type { AutomationService, CreationAuthority } from "./service.js";

const EmptySchema = z.object({}).strict();
export const UpdateAutomationSchema = z.union([
  z.object({ id: z.string().uuid(), status: z.enum(["active", "paused", "cancelled"]) }).strict(),
  z.object({ id: z.string().uuid(), ...UpdateBackgroundPromptSchema.shape }).strict(),
]);
const IdSchema = z.object({ id: z.string().uuid() }).strict();
function tool(name: string, description: string, schema: z.ZodType): ModelTool {
  return { type: "function", function: { name, description, parameters: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> } };
}
export const AUTOMATION_TOOLS: ModelTool[] = [
  tool("create_automation", "在用户本轮明确要求时，创建提醒、会话定时任务或隔离后台任务。立即开始的独立工作、或等待已有任务完成，用 kind=background，把配置放进 background 对象，并用 timing.type=at 加当前时间。后台默认 Codex，background.executor 只有在当前用户明确要求这一项任务使用 Claude 时才填 claude；其他任务仍用 Codex，选择随定时任务和追问保存。提及 Claude 主题、源会话、引用或假设不授权切换。做跨机器只读监控前先发现全部源定时任务，不给它们的会话派发。会话定时任务用已发现的节点和会话 ID。开始运行时不通知，有意义的结果和失败通过统一结果队列发送。", CreateScheduleSchema),
  tool("list_automations", "列出当前用户的定时任务及状态。", EmptySchema),
  tool("update_automation", "只在用户本轮明确要求时调用，两种用法不能混用：用 id+status 暂停、恢复或取消；或用 id+prompt+expectedPromptRevision 修改后台定时任务今后每次运行的正文。改正文前先读取任务，expectedPromptRevision 填 latestPromptUpdate.revision，没有就填 0；版本冲突时先核对最新正文，不要直接重试。正在运行的这一次和已结束的任务不能改正文。改正文保留来源、时间和历史结果，只影响以后的运行。", UpdateAutomationSchema),
  tool("automation_runs", "读取某个定时任务已记录的运行结果和命令状态。", IdSchema),
];
export const AUTOMATION_ARGUMENTS = { create_automation: CreateScheduleSchema, list_automations: EmptySchema,
  update_automation: UpdateAutomationSchema, automation_runs: IdSchema };
export const AUTOMATION_TOOL_NAMES = new Set(AUTOMATION_TOOLS.map(tool => tool.function.name));
export async function executeAutomationTool(service: AutomationService, name: string, raw: unknown,
  authority: CreationAuthority, now = Date.now()): Promise<unknown> {
  if (name === "create_automation") return service.create(CreateScheduleSchema.parse(raw), authority);
  if (name === "list_automations") { EmptySchema.parse(raw); return service.repository.list(authority.chatId); }
  if (name === "automation_runs") return service.repository.listRuns(IdSchema.parse(raw).id, authority.chatId);
  if (name === "update_automation") {
    if (!authority.explicitCurrentTurnAuthorization) throw new Error("Updating an automation requires explicit current-turn user authorization");
    const input = UpdateAutomationSchema.parse(raw);
    if ("prompt" in input) return service.updatePrompt(input.id, {
      prompt: input.prompt, expectedPromptRevision: input.expectedPromptRevision,
    }, authority, now);
    await authority.assertCurrentAuthority?.();
    return service.repository.setStatus(input.id, authority.chatId, input.status, now);
  }
  throw new Error("Unknown automation tool");
}
