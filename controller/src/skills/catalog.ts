import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_SELECTED_SKILLS = 4;
export const SkillRefSchema = z.object({ id: digest, digest }).strict();
export const SkillRefsSchema = z.array(SkillRefSchema).max(MAX_SELECTED_SKILLS).refine(
  refs => new Set(refs.map(ref => ref.id)).size === refs.length, "Duplicate selected skill IDs",
);
export type SkillRef = z.infer<typeof SkillRefSchema>;
export const SkillSchema = z.object({
  id: digest, digest, name: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/), description: z.string().max(500),
  path: z.string().max(1024).startsWith("/"),
});
export type Skill = z.infer<typeof SkillSchema>;
export const SkillCatalogSchema = z.array(SkillSchema).max(256).default([]).refine(
  items => new Set(items.map(item => item.id)).size === items.length, "Duplicate skill IDs",
);
export function sameSkillRefs(a?: SkillRef[], b?: SkillRef[]): boolean {
  return JSON.stringify((a ?? []).map(ref => [ref.id, ref.digest])) === JSON.stringify((b ?? []).map(ref => [ref.id, ref.digest]));
}
export function hasSkillRefs(catalog: Skill[], refs?: SkillRef[]): boolean {
  return (refs ?? []).every(ref => catalog.some(item => item.id === ref.id && item.digest === ref.digest));
}
