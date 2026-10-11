export const DEFAULT_MESSAGE_MAX_CHARS = 4000;
export const TRUNCATION_NOTICE = "\n\n[内容过长，已截断]";

// Budgets use UTF-16 units, but boundaries must not divide surrogate pairs.
export function unicodeSafeBoundary(text: string, end: number): number {
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

function prose(value: string, layout: boolean): string {
  const markers = ["\\*\\*", "__", "~~", "\\*", "_"];
  for (const marker of markers) {
    const regex = new RegExp("(?<![\\w/])" + marker + "(?=\\S)([^\\n]+?\\S|\\S)" + marker + "(?![\\w/])", "g");
    value = value.replace(regex, "$1");
  }
  if (layout) {
    value = value.replace(/^#{1,6}[ \t]+/gm, "");
    value = value.replace(/^[ \t]*-[ \t]+/gm, "• ");
  }
  return value;
}

export function renderMarkdown(text: string, maxChars: number = DEFAULT_MESSAGE_MAX_CHARS, layout: boolean = true): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a nonnegative safe integer");
  }

  const pattern = /(?:^```[^\n]*\n([\s\S]*?)^```[ \t]*(?=\n|$)|`([^`\n]+)`|(!)?\[([^\]\n]+)\]\(([^)\n]+)\)|(https?:\/\/[^\s<>`]+))/gm;
  const parts: string[] = [];
  let previous = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    parts.push(prose(text.slice(previous, match.index), layout));
    const fence = match[1];
    const code = match[2];
    const isImage = match[3];
    const linkLabel = match[4];
    const linkUrl = match[5];
    const bareUrl = match[6];

    if (fence !== undefined) {
      parts.push(fence);
    } else if (code !== undefined) {
      parts.push(code);
    } else if (isImage !== undefined) {
      parts.push(prose(linkLabel, layout));
    } else if (linkLabel !== undefined && linkUrl !== undefined) {
      const label = prose(linkLabel, layout);
      parts.push(layout ? label + " (" + linkUrl + ")" : label + ": " + linkUrl);
    } else if (bareUrl !== undefined) {
      // URLs are opaque payloads: Markdown markers can be part of a credential.
      parts.push(bareUrl);
    }
    previous = pattern.lastIndex;
  }

  parts.push(prose(text.slice(previous), layout));
  const rendered = parts.join("").trim();

  if (rendered.length <= maxChars) {
    return rendered;
  }
  if (maxChars === 0) {
    return "";
  }
  const notice = maxChars >= TRUNCATION_NOTICE.length ? TRUNCATION_NOTICE : "…";
  const end = unicodeSafeBoundary(rendered, maxChars - notice.length);
  return rendered.slice(0, end) + notice;
}

export function markdownToWeChat(text: string, maxChars: number = DEFAULT_MESSAGE_MAX_CHARS): string {
  return renderMarkdown(text, maxChars, true);
}

export function markdownForWeChat(text: string, maxChars: number = DEFAULT_MESSAGE_MAX_CHARS): string {
  return renderMarkdown(text, maxChars, false);
}
