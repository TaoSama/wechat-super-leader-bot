export const MAX_AUTOMATION_TOOL_RESULT_CHARS = 12_000;
const BODY_PREVIEW_CHARS = 256;
type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);

function compactBodies(value: unknown, limit: number): unknown {
  if (!isRecord(value)) return value;
  const result = { ...value };
  let truncated = false;
  const shorten = (object: RecordValue, key: string) => {
    const body = object[key];
    if (typeof body !== "string" || body.length <= limit) return;
    const preview = body.slice(0, limit);
    object[key] = /[\uD800-\uDBFF]$/.test(preview) ? preview.slice(0, -1) : preview;
    truncated = true;
  };
  for (const key of ["prompt", "text", "error"]) shorten(result, key);
  for (const key of ["background", "result"]) {
    if (!isRecord(value[key])) continue;
    const nested = { ...value[key] };
    for (const bodyKey of ["prompt", "text", "error"]) shorten(nested, bodyKey);
    if (key === "background" && Array.isArray(nested.preferences)) {
      nested.preferences = nested.preferences.map(preference => {
        const holder = { text: preference };
        shorten(holder, "text");
        return holder.text;
      });
    }
    result[key] = nested;
  }
  return truncated ? { ...result, bodyTruncated: true } : result;
}

/** Preserve editable schedule identities and revisions even when their bodies exceed the model budget. */
export function formatAutomationToolResult(output: unknown): string {
  const original = JSON.stringify(output);
  if (original.length <= MAX_AUTOMATION_TOOL_RESULT_CHARS) return original;
  for (const limit of [BODY_PREVIEW_CHARS, 0]) {
    const compact = Array.isArray(output) ? output.map(item => compactBodies(item, limit)) : compactBodies(output, limit);
    const content = JSON.stringify(Array.isArray(compact) ? { items: compact, truncated: true, omittedCount: 0 } : compact);
    if (content.length <= MAX_AUTOMATION_TOOL_RESULT_CHARS) return content;
  }
  if (!Array.isArray(output)) return JSON.stringify({ truncated: true, omittedCount: 1 });

  const items: unknown[] = [];
  const envelope = { items, truncated: true, omittedCount: output.length };
  let length = JSON.stringify(envelope).length;
  for (const item of output) {
    const compact = compactBodies(item, 0);
    const addition = JSON.stringify(compact).length + (items.length ? 1 : 0);
    if (length + addition > MAX_AUTOMATION_TOOL_RESULT_CHARS) continue;
    items.push(compact);
    length += addition;
  }
  envelope.omittedCount = output.length - items.length;
  return JSON.stringify(envelope);
}
