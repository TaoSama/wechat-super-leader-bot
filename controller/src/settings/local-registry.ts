import { z } from "zod";
import type { ModelTool } from "../leader/model/contracts.js";
import { SYSTEM_PROMPT, LEADER_TOOLS, ToolArguments } from "../leader/contracts.js";
import { DIRECT_TOOL_INSTRUCTIONS } from "../leader/direct-contracts.js";
import { BACKGROUND_INSTRUCTIONS, BACKGROUND_TOOLS, BACKGROUND_ARGUMENTS } from "../leader/background-tools.js";
import { AUTOMATION_TOOLS, AUTOMATION_ARGUMENTS } from "../automations/tools.js";
import { ACKNOWLEDGEMENT_PROMPT } from "../leader/acknowledgement.js";
import { GOAL_DECISION_PROMPT, GOAL_DECISION_TOOL } from "../leader/goals/model.js";
import { GoalDecisionSchema } from "../leader/goals/goal.js";
import { AUTHORIZATION_PROMPT, AUTHORIZATION_TOOL, AuthorizationSchema } from "../leader/model/user-authorization.js";
import { PROMPT as AUTOMATION_PROMPT, AUTOMATION_AUTHORIZATION_TOOL, ClassificationSchema as AutomationClassification } from "../leader/model/automation-authorization.js";
import { PROMPT as BACKGROUND_PROMPT, BACKGROUND_AUTHORIZATION_TOOL, ClassificationSchema as BackgroundClassification } from "../leader/model/background-authorization.js";
import { IMAGE_AUTH_PROMPT, ImageAuthorizationTool, ImageAuthorizationSchema } from "../leader/queries/session-images.js";
import { PROGRESS_SYSTEM_PROMPT, REPORT_PROGRESS_TOOL, Arguments as ProgressArguments } from "../notifications/model-progress.js";
import { RESULT_SUMMARY_PROMPT } from "../deliveries/service.js";
import { WORKER_SYSTEM_PROMPT } from "../background/worker/output.js";

const EMPTY = { type: "object", properties: {}, additionalProperties: false };
export const DIRECT_EXTRA_TOOLS: ModelTool[] = [
  { name: "confirm_pending", description: "Consume the real current user's confirmation of the uniquely displayed, unexpired plan or goal; never confirms the agent's own preview." },
  { name: "cancel_plan", description: "Cancel pending or future fixed-plan steps when explicitly requested; does not stop an already running source task." },
  { name: "cancel_goal", description: "Cancel this chat's pending or active goal when explicitly requested; does not stop source tasks already running." },
].map(item => ({ type: "function", function: { ...item, parameters: EMPTY } }));

export interface RegisteredPrompt { name: string; title: string; content: string; scope: string; path: string }
export const LOCAL_PROMPTS: RegisteredPrompt[] = [
  { name: "leader", title: "内部协调提示词", content: SYSTEM_PROMPT, scope: "controller", path: "leader/contracts.ts · SYSTEM_PROMPT" },
  { name: "direct", title: "微信业务工具协议提示词", content: DIRECT_TOOL_INSTRUCTIONS, scope: "controller", path: "leader/direct-contracts.ts · DIRECT_TOOL_INSTRUCTIONS" },
  { name: "background-tools", title: "后台任务工具提示词", content: BACKGROUND_INSTRUCTIONS, scope: "controller", path: "leader/background-tools.ts · BACKGROUND_INSTRUCTIONS" },
  { name: "acknowledgement", title: "执行回执提示词", content: ACKNOWLEDGEMENT_PROMPT, scope: "controller", path: "leader/acknowledgement.ts · ACKNOWLEDGEMENT_PROMPT" },
  { name: "goal", title: "持续目标决策提示词", content: GOAL_DECISION_PROMPT, scope: "controller", path: "leader/goals/model.ts · GOAL_DECISION_PROMPT" },
  { name: "authorization", title: "用户授权分类提示词", content: AUTHORIZATION_PROMPT, scope: "controller", path: "leader/model/user-authorization.ts · AUTHORIZATION_PROMPT" },
  { name: "automation-authorization", title: "定时任务授权提示词", content: AUTOMATION_PROMPT, scope: "controller", path: "leader/model/automation-authorization.ts · PROMPT" },
  { name: "background-authorization", title: "后台任务授权提示词", content: BACKGROUND_PROMPT, scope: "controller", path: "leader/model/background-authorization.ts · PROMPT" },
  { name: "image-authorization", title: "图片投递授权提示词", content: IMAGE_AUTH_PROMPT, scope: "controller", path: "leader/queries/session-images.ts · IMAGE_AUTH_PROMPT" },
  { name: "progress", title: "进展通知提示词", content: PROGRESS_SYSTEM_PROMPT, scope: "controller", path: "notifications/model-progress.ts · PROGRESS_SYSTEM_PROMPT" },
  { name: "result-summary", title: "成果摘要提示词", content: RESULT_SUMMARY_PROMPT, scope: "controller", path: "deliveries/service.ts · RESULT_SUMMARY_PROMPT" },
  { name: "background-worker", title: "隔离后台会话提示词", content: WORKER_SYSTEM_PROMPT, scope: "background", path: "background/worker/output.ts · WORKER_SYSTEM_PROMPT" },
];
export const LOCAL_TOOLS: ModelTool[] = [...LEADER_TOOLS, ...AUTOMATION_TOOLS, ...BACKGROUND_TOOLS, ...DIRECT_EXTRA_TOOLS,
  GOAL_DECISION_TOOL, AUTHORIZATION_TOOL, AUTOMATION_AUTHORIZATION_TOOL, BACKGROUND_AUTHORIZATION_TOOL,
  ImageAuthorizationTool, REPORT_PROGRESS_TOOL];
export const LOCAL_TOOL_VALIDATORS: Record<string, z.ZodType> = {
  ...ToolArguments, ...AUTOMATION_ARGUMENTS, ...BACKGROUND_ARGUMENTS,
  confirm_pending: z.object({}).strict(), cancel_plan: z.object({}).strict(), cancel_goal: z.object({}).strict(),
  decide_goal: GoalDecisionSchema, classify_user_authorization: AuthorizationSchema,
  classify_automation_authorization: AutomationClassification, classify_background_authorization: BackgroundClassification,
  classify_image_delivery: ImageAuthorizationSchema, report_progress: ProgressArguments,
};
