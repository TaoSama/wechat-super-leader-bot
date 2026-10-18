import { z } from "zod";
import type { ModelTool } from "../leader/model/contracts.js";
import { CreateScheduleSchema } from "./contracts.js";
import type { AutomationService, CreationAuthority } from "./service.js";

const EmptySchema = z.object({}).strict();
const UpdateSchema = z.object({ id: z.string().uuid(), status: z.enum(["active", "paused", "cancelled"]) }).strict();
const IdSchema = z.object({ id: z.string().uuid() }).strict();
function tool(name: string, description: string, schema: z.ZodType): ModelTool {
  return { type: "function", function: { name, description, parameters: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> } };
}
export const AUTOMATION_TOOLS: ModelTool[] = [
  tool("create_automation", "Create a reminder, session schedule, or isolated background task with current human authorization. For immediate independent work or waiting for existing tasks to finish, use kind=background, nested background spec, and timing.type=at with the current time. Discover all source automations before configuring read-only cross-machine monitoring; never dispatch to their sessions. Use discovered node/session IDs for session schedules. Starting is silent; meaningful results and failures use the unified result queue.", CreateScheduleSchema),
  tool("list_automations", "List current user's schedules and statuses", EmptySchema),
  tool("update_automation", "Pause, resume or cancel a schedule explicitly requested by the current user", UpdateSchema),
  tool("automation_runs", "Read persisted schedule execution results and command status", IdSchema),
];
export const AUTOMATION_TOOL_NAMES = new Set(AUTOMATION_TOOLS.map(tool => tool.function.name));
export async function executeAutomationTool(service: AutomationService, name: string, raw: unknown,
  authority: CreationAuthority, now = Date.now()): Promise<unknown> {
  if (name === "create_automation") return service.create(CreateScheduleSchema.parse(raw), authority);
  if (name === "list_automations") { EmptySchema.parse(raw); return service.repository.list(authority.chatId); }
  if (name === "automation_runs") return service.repository.listRuns(IdSchema.parse(raw).id, authority.chatId);
  if (name === "update_automation") {
    if (!authority.explicitCurrentTurnAuthorization) throw new Error("Updating an automation requires explicit current-turn user authorization");
    const input = UpdateSchema.parse(raw);
    await authority.assertCurrentAuthority?.();
    return service.repository.setStatus(input.id, authority.chatId, input.status, now);
  }
  throw new Error("Unknown automation tool");
}
