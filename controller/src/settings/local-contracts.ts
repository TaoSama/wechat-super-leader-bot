import { z } from "zod";

export type LocalModelScopeId = "controller" | "background";
export interface ModelProvider { model: string; baseUrl: string; apiKey: string }
export interface LocalModelChoice { model: string; reasoningEffort: string | null }
export interface LocalModelScope extends LocalModelChoice {
  id: LocalModelScopeId; label: string; revision: string; editable: boolean; effect: string; provider: string;
}
export interface LocalModelCatalog {
  scope: string;
  models: { id: string; label: string; reasoningEfforts: string[]; defaultReasoningEffort?: string; contextWindow?: number;
    metadataSource?: "provider" | "cli-bundled" }[];
  fetchedAt: string; source: string; version: string; stale: boolean;
}
export interface LocalResource {
  id: string; kind: "prompt" | "tool"; title: string; scope: string; path: string;
  revision: string; version: string; editable: boolean; effect: string; reason?: string;
  /** The saved override was based on an older default. */
  stale: boolean;
}
export interface LocalResourceDocument extends LocalResource { content: string; language: string; defaultContent?: string }
export interface LocalSettingsData {
  format: 1;
  models: Partial<Record<LocalModelScopeId, LocalModelChoice>>;
  resources: Record<string, string>;
  /** Revision of the default each override was based on; missing for overrides saved before this was recorded. */
  resourceBases?: Record<string, string>;
}
export const LocalSettingsDataSchema = z.object({
  format: z.literal(1),
  models: z.object({
    controller: z.object({ model: z.string().trim().min(1).max(200), reasoningEffort: z.string().regex(/^[a-z_]{1,32}$/).nullable() }).strict().optional(),
    background: z.object({ model: z.string().trim().min(1).max(200), reasoningEffort: z.string().regex(/^[a-z_]{1,32}$/).nullable() }).strict().optional(),
  }).strict(),
  resources: z.record(z.string(), z.string()),
  resourceBases: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
}).strict();
export class LocalSettingsError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string) { super(message); }
}
export const RESOURCE_EFFECT = "下一轮生效；已开始的轮次保留原版本";
export const MAX_RESOURCE_BYTES = 256 * 1024;
