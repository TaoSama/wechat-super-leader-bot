// Conservative client budget in UTF-16 code units; the protocol publishes no text hard limit.
export const DEFAULT_MESSAGE_MAX_CHARS = 3800;
export const TRUNCATION_NOTICE = "\n\n[内容过长，已截断]";

// Budgets use UTF-16 units, but boundaries must not divide surrogate pairs.
export function unicodeSafeBoundary(text: string, end: number): number {
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? end - 1 : end;
}

function prose(value: string, layout: boolean): string {
  if (layout) {
    // A heading may arrive glued to the preceding sentence or with its closing marker on another line.
    value = value.replace(/(?:\*\*|__)([^\n*]{1,80}[:：])[ \t]*(?:(?:\r?\n[ \t]*)*(?:\*\*|__)|(?=\n|[①-⑳]|$))/g,
      (whole, heading: string, offset: number) => {
        const before = value.slice(0, offset);
        const after = value.slice(offset + whole.length);
        return (before && !before.endsWith("\n") ? "\n\n" : "") + heading + (after.startsWith("\n") ? "" : "\n");
      });
  }
  // Stars can emphasize a word inside another word; underscores cannot.
  // Keep whitespace-delimited arithmetic and unpaired markers intact.
  const markers = [
    { marker: "\\*\\*", boundary: "[*/\\\\]" },
    { marker: "__", boundary: "[\\p{L}\\p{N}_/\\\\]" },
    { marker: "~~", boundary: "[~/\\\\]" },
    { marker: "\\*", boundary: "[*/\\\\]" },
    { marker: "_", boundary: "[\\p{L}\\p{N}_/\\\\]" },
  ];
  for (const { marker, boundary } of markers) {
    const closingLine = marker === "\\*\\*" || marker === "__" ? "([ \\t]*\\r?\\n[ \\t]*)?" : "()";
    const regex = new RegExp("(?<!" + boundary + ")" + marker + "(?=\\S)([\\s\\S]*?\\S|\\S)" + closingLine + marker + "(?!" + boundary + ")", "gu");
    value = value.replace(regex, "$1$2");
  }
  // Isolated strong delimiters are a common model formatting error, not visible prose.
  value = value.replace(/^[ \t]*(?:\*\*|__)[ \t]*(?:\r?\n|$)/gm, "");
  if (layout) {
    value = value.replace(/^#{1,6}[ \t]+(.+)$/gm, "$1");
    value = value.replace(/^[ \t]*[-+*][ \t]+/gm, "• ");
    value = value.replace(/^•[ \t]+(?=[①-⑳])/gm, "");
    value = value.split(/(\n[ \t]*\n)/).map(paragraph => {
      const count = paragraph.match(/[①-⑳]/g)?.length ?? 0;
      const pattern = count > 1 ? /[ \t]*([①-⑳])[ \t]*/g : /(?<=^|[:：])[ \t]*([①-⑳])[ \t]*/g;
      return paragraph.replace(pattern, (_whole, marker: string, offset: number) =>
        (offset === 0 || paragraph[offset - 1] === "\n" ? "" : "\n") + marker + " ");
    }).join("");
    value = value.replace(/\n{3,}/g, "\n\n");
  }
  return value;
}

function protectCodeBlocks(text: string, token: (value: string) => string, inline: (value: string) => string): string {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  const parts: string[] = [];
  let previous = 0;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(text)) !== null) {
    const delimiter = match[1]!;
    // A backtick in a backtick fence's info string makes it prose, rather than a fence.
    if (delimiter[0] === "`" && match[2]!.includes("`")) continue;
    const contentStart = opening.lastIndex;
    const closing = new RegExp("^ {0,3}" + delimiter[0] + "{" + delimiter.length + ",}[ \\t]*(?=\\r?$)", "gm");
    closing.lastIndex = contentStart;
    const end = closing.exec(text);
    parts.push(inline(text.slice(previous, match.index)), token(text.slice(contentStart, end?.index ?? text.length)));
    previous = end ? closing.lastIndex : text.length;
    opening.lastIndex = previous;
    if (!end) break;
  }
  parts.push(inline(text.slice(previous)));
  return parts.join("");
}

export function renderMarkdown(text: string, maxChars: number = DEFAULT_MESSAGE_MAX_CHARS, layout: boolean = true): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a nonnegative safe integer");
  }

  const pattern = /(?:(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)|(!)?\[([^\]\n]+)\]\(([^)\n]+)\)|(https?:\/\/[^\s<>`]+)|((?<![\w*])(?:~?\/|\.{1,2}\/|[A-Za-z]:\\)[^\s<>`]+))/gm;
  const opaque: string[] = [];
  let tokenPrefix = "\uE000wechat:";
  while (text.includes(tokenPrefix)) tokenPrefix += ":";
  const token = (value: string): string => {
    const index = opaque.push(value) - 1;
    return `${tokenPrefix}${index}\uE001`;
  };
  const inline = (value: string): string => value.replace(pattern, (_whole, delimiter: string | undefined, code: string | undefined,
    isImage: string | undefined, linkLabel: string | undefined, linkUrl: string | undefined, bareUrl: string | undefined,
    path: string | undefined) => {
    if (delimiter !== undefined) return token(code!);
    if (isImage !== undefined) return token(prose(linkLabel!, layout));
    if (linkLabel !== undefined && linkUrl !== undefined) {
      const label = prose(linkLabel, layout);
      return token(layout ? label + " (" + linkUrl + ")" : label + ": " + linkUrl);
    }
    return token(bareUrl ?? path!);
  });
  const protectedText = protectCodeBlocks(text, token, inline);
  // Trim surrounding prose while code contents are still protected, including its boundary indentation.
  const formatted = prose(protectedText, layout).trim();
  const rendered = formatted.replace(new RegExp(tokenPrefix + "(\\d+)\uE001", "g"),
    (_whole, index: string) => opaque[Number(index)]);

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
