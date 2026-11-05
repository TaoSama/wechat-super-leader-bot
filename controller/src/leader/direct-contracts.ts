import { z } from "zod";
import { PostMessageRequestSchema } from "../types.js";
import type { LeaderReply } from "./contracts.js";
import { BACKGROUND_INSTRUCTIONS } from "./background-tools.js";
import { AUTOMATION_INSTRUCTIONS } from "../automations/instructions.js";
import { AutomationOperationSchema } from "./model/automation-authorization.js";

/**
 * Old Gateways still send a self-reported attestation for one release. It grants nothing:
 * permission derives from the tool name and arguments. It is kept only so the journal can
 * match records written while it was part of the call fingerprint.
 */
const LegacyAuthorizationFieldsSchema = z.object({
  intent: z.enum(["task", "goal", "preview", "query", "isolated_background", "unclear"]).default("query"),
  automationOperations: z.array(AutomationOperationSchema).default([]),
  backgroundOperations: z.array(z.enum(["create", "follow_up", "extend"])).default([]),
  sendImages: z.boolean().default(false),
  interruptSession: z.boolean().default(false),
  approvalDecision: z.enum(["none", "accept", "decline"]).default("none"),
  memoryOperations: z.array(z.enum(["remember", "forget"])).default([]),
}).strict();

// Zod defaults bypass parsing; construct the complete value instead of returning an empty object.
export const LegacyDirectAuthorizationSchema = LegacyAuthorizationFieldsSchema.default(() => LegacyAuthorizationFieldsSchema.parse({}));
export const DirectRequestSchema = PostMessageRequestSchema.strict();
export const CancelPlanArgumentsSchema = z.object({ planId: z.string().uuid().optional() }).strict();
export const DirectCallSchema = DirectRequestSchema.extend({
  callId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  arguments: z.unknown(),
  authorization: LegacyDirectAuthorizationSchema.optional(),
}).strict();

export type LegacyDirectAuthorization = z.infer<typeof LegacyDirectAuthorizationSchema>;
export type DirectRequest = z.infer<typeof DirectRequestSchema>;
export type DirectCall = z.infer<typeof DirectCallSchema>;
export type DirectToolResult = { result: unknown; reply?: LeaderReply };

/** Cross-tool facts for the outer Codex; per-tool rules live in tool descriptions and parameter schemas. */
export const DIRECT_TOOL_INSTRUCTIONS = `业务工具的共同规则：
1. 用户明确交代、目标和范围清楚的任务，直接用 execute_plan 或 execute_goal，不再让用户确认。用户说“先看方案”“先别执行”时用 propose_plan 或 propose_goal。目标、会话或范围不清楚时先问。只是查询时只用查询工具。
2. 用户回复“好”“就这样”时：上文只有一个他本人提出或认可的待办，就按原范围执行；有多个或没有，先问是哪一个。询问能不能做、讨论方案、假设、引用别人的话、否定，都不执行变更。
3. 回执照实转述：accepted 是“已接收，等待完成”；input-written 是“已写入终端，未确认执行”；uncertain 是“结果不明”，不要重发。完成要有终态回执或会话输出作证据。
4. 会话忙、检查中、暂时失联，不等于不能发送；服务端会保留路线，等可用时再派发。你不能指定 sendRoute，被拒绝时不要换路。
5. 回复里用会话标题和机器名。用户没要的话，不展示 UUID、命令 ID、turnId、技能哈希或原始 JSON。

${AUTOMATION_INSTRUCTIONS}

${BACKGROUND_INSTRUCTIONS}`;
