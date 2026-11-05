import { LOCAL_PROMPTS, type RegisteredPrompt } from "./local-registry.js";

type Segment = string | { prompt: string };
type Overrides = Readonly<Record<string, string>>;
const promptId = (name: string) => `controller.prompt.${name}`;

function registered(name: string): RegisteredPrompt {
  const prompt = LOCAL_PROMPTS.find(item => item.name === name);
  if (!prompt) throw new Error(`Unknown registered prompt ${name}`);
  return prompt;
}

function compile(prompt: RegisteredPrompt): Segment[] {
  const spans = (prompt.parts ?? []).map(name => {
    const text = registered(name).content, start = prompt.content.indexOf(text);
    if (start < 0 || prompt.content.indexOf(text, start + 1) >= 0) {
      throw new Error(`Prompt ${prompt.name} must contain prompt ${name} exactly once; update its parts declaration`);
    }
    return { name, start, end: start + text.length };
  }).sort((left, right) => left.start - right.start);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) throw new Error(`Prompt ${prompt.name} declares overlapping parts`);
    segments.push(prompt.content.slice(cursor, span.start), { prompt: span.name });
    cursor = span.end;
  }
  segments.push(prompt.content.slice(cursor));
  return segments;
}

const TEMPLATES = new Map(LOCAL_PROMPTS.filter(prompt => prompt.parts?.length).map(prompt => [prompt.name, compile(prompt)]));

/** A composite's own override wins; otherwise each embedded prompt contributes its current text. */
export function composePrompt(name: string, overrides: Overrides): string {
  const override = overrides[promptId(name)];
  if (override !== undefined) return override;
  const template = TEMPLATES.get(name);
  if (!template) return registered(name).content;
  return template.map(segment => typeof segment === "string" ? segment
    : overrides[promptId(segment.prompt)] ?? registered(segment.prompt).content).join("");
}

/** Settings page explanation of how an edit reaches other prompts. */
export function compositionNote(name: string): string | undefined {
  const prompt = registered(name);
  if (prompt.parts?.length) {
    const titles = prompt.parts.map(part => registered(part).title).join("、");
    return `未单独保存时，本提示词由 ${titles} 的当前内容和本提示词的其余默认内容拼成；单独保存后以这里的全文为准。`;
  }
  const composites = LOCAL_PROMPTS.filter(item => item.parts?.includes(name)).map(item => item.title);
  return composites.length ? `修改后同时用于${composites.join("、")}。` : undefined;
}
