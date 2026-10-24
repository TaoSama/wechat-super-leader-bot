import type { ModelTool } from "../leader/model/contracts.js";
import { LocalSettingsError } from "./local-contracts.js";

const ANNOTATIONS = new Set(["description", "title", "examples", "$comment"]);
const LOWER_BOUNDS = new Set(["minLength", "minItems", "minimum", "exclusiveMinimum", "minProperties"]);
const UPPER_BOUNDS = new Set(["maxLength", "maxItems", "maximum", "exclusiveMaximum", "maxProperties"]);
const clone = <T>(value: T): T => structuredClone(value);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw new LocalSettingsError(400, "工具身份和结构必须保留；仅支持修改说明、缩小枚举或收紧已有数值/长度边界", "INCOMPATIBLE_TOOL_SCHEMA");
}

/** Only a mechanically provable subset of schema narrowing is editable. Dispatch keeps its original Zod validation. */
function compatible(base: unknown, next: unknown, context = "schema", allowNarrow = true): void {
  if (JSON.stringify(base) === JSON.stringify(next)) return;
  if (Array.isArray(base)) {
    if (!Array.isArray(next) || next.length !== base.length) invalid();
    base.forEach((item, index) => compatible(item, next[index], context, allowNarrow));
    return;
  }
  if (!object(base) || !object(next)) invalid();
  for (const key of Object.keys(base)) if (!(key in next)) invalid();
  for (const [key, value] of Object.entries(next)) {
    if (context === "schema" && ANNOTATIONS.has(key)) {
      if ((key === "examples" && !Array.isArray(value)) || (key !== "examples" && typeof value !== "string")) invalid();
    } else if (context === "schema" && key === "enum") {
      if (!allowNarrow && JSON.stringify(base[key]) !== JSON.stringify(value)) invalid();
      if (!Array.isArray(base.enum) || !Array.isArray(value) || !value.length ||
        new Set(value.map(item => JSON.stringify(item))).size !== value.length ||
        value.some(item => !(base.enum as unknown[]).some((original: unknown) => JSON.stringify(original) === JSON.stringify(item)))) invalid();
    } else if (context === "schema" && (LOWER_BOUNDS.has(key) || UPPER_BOUNDS.has(key))) {
      if (!allowNarrow && base[key] !== value) invalid();
      if (typeof base[key] !== "number" || typeof value !== "number" || !Number.isFinite(value) ||
          (LOWER_BOUNDS.has(key) ? value < (base[key] as number) : value > (base[key] as number))) invalid();
      if (["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(key) && (!Number.isSafeInteger(value) || value < 0)) invalid();
    } else {
      if (!(key in base)) invalid();
      const childCanNarrow = context === "map" || ["properties", "items", "additionalProperties", "allOf"].includes(key);
      compatible(base[key], value, key === "properties" || key === "$defs" ? "map" : "schema", allowNarrow && childCanNarrow);
    }
  }
  for (const [min, max] of [["minLength", "maxLength"], ["minItems", "maxItems"], ["minimum", "maximum"], ["minProperties", "maxProperties"]]) {
    if (typeof next[min] === "number" && typeof next[max] === "number" && next[min] > next[max]) invalid();
  }
}

export function parseCompatibleTool(base: ModelTool, content: string): ModelTool {
  let value: unknown;
  try { value = JSON.parse(content); } catch { invalid(); }
  if (!object(value) || Object.keys(value).sort().join(",") !== "description,name,parameters" ||
      value.name !== base.function.name || typeof value.description !== "string" || !value.description.trim() || !object(value.parameters)) invalid();
  compatible(base.function.parameters, value.parameters);
  return { type: "function", function: { name: base.function.name, description: value.description,
    parameters: clone(value.parameters) } };
}

/** Check edited constraints as an additional guard; it never substitutes for the executor's original Zod contract. */
export function assertEditedArguments(base: unknown, edited: unknown, value: unknown): void {
  if (JSON.stringify(base) === JSON.stringify(edited)) return;
  if (!object(base) || !object(edited)) return;
  const reject = () => { throw new LocalSettingsError(400, "参数不符合当前工具 Schema 的收紧约束", "EDITED_TOOL_ARGUMENTS_REJECTED"); };
  if (Array.isArray(edited.enum) && !edited.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) reject();
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof edited.minLength === "number" && length < edited.minLength || typeof edited.maxLength === "number" && length > edited.maxLength) reject();
  }
  if (typeof value === "number" && (
    typeof edited.minimum === "number" && value < edited.minimum || typeof edited.maximum === "number" && value > edited.maximum ||
    typeof edited.exclusiveMinimum === "number" && value <= edited.exclusiveMinimum || typeof edited.exclusiveMaximum === "number" && value >= edited.exclusiveMaximum)) reject();
  if (Array.isArray(value)) {
    if (typeof edited.minItems === "number" && value.length < edited.minItems || typeof edited.maxItems === "number" && value.length > edited.maxItems) reject();
    value.forEach(item => assertEditedArguments(base.items, edited.items, item));
  }
  if (object(value)) {
    const propertyCount = Object.keys(value).length;
    if (typeof edited.minProperties === "number" && propertyCount < edited.minProperties ||
        typeof edited.maxProperties === "number" && propertyCount > edited.maxProperties) reject();
    for (const key of Object.keys(value)) {
      const properties = object(edited.properties) ? edited.properties : {}, baseProperties = object(base.properties) ? base.properties : {};
      if (key in properties) assertEditedArguments(baseProperties[key], properties[key], value[key]);
      else assertEditedArguments(base.additionalProperties, edited.additionalProperties, value[key]);
    }
  }
  for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
    const before = base[combinator], after = edited[combinator];
    if (!Array.isArray(before) || !Array.isArray(after)) continue;
    if (combinator === "allOf") after.forEach((item, index) => assertEditedArguments(before[index], item, value));
    // Union branches only accept annotation edits; no extra validation is needed.
  }
}
