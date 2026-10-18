const DEFAULT_MESSAGE_MAX_CHARS = 3800;
const TRUNCATION_NOTICE = "\n\n[\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD]";
function unicodeSafeBoundary(text, end) {
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return last >= 55296 && last <= 56319 && next >= 56320 && next <= 57343 ? end - 1 : end;
}
function prose(value, layout) {
  if (layout) {
    value = value.replace(
      /(?:\*\*|__)([^\n*]{1,80}[:：])[ \t]*(?:(?:\r?\n[ \t]*)*(?:\*\*|__)|(?=\n|[①-⑳]|$))/g,
      (whole, heading, offset) => {
        const before = value.slice(0, offset);
        const after = value.slice(offset + whole.length);
        return (before && !before.endsWith("\n") ? "\n\n" : "") + heading + (after.startsWith("\n") ? "" : "\n");
      }
    );
  }
  const markers = [
    { marker: "\\*\\*", boundary: "[*/\\\\]" },
    { marker: "__", boundary: "[\\p{L}\\p{N}_/\\\\]" },
    { marker: "~~", boundary: "[~/\\\\]" },
    { marker: "\\*", boundary: "[*/\\\\]" },
    { marker: "_", boundary: "[\\p{L}\\p{N}_/\\\\]" }
  ];
  for (const { marker, boundary } of markers) {
    const closingLine = marker === "\\*\\*" || marker === "__" ? "([ \\t]*\\r?\\n[ \\t]*)?" : "()";
    const regex = new RegExp("(?<!" + boundary + ")" + marker + "(?=\\S)([\\s\\S]*?\\S|\\S)" + closingLine + marker + "(?!" + boundary + ")", "gu");
    value = value.replace(regex, "$1$2");
  }
  value = value.replace(/^[ \t]*(?:\*\*|__)[ \t]*(?:\r?\n|$)/gm, "");
  if (layout) {
    value = value.replace(/^#{1,6}[ \t]+(.+)$/gm, "$1");
    value = value.replace(/^[ \t]*[-+*][ \t]+/gm, "\u2022 ");
    value = value.replace(/^•[ \t]+(?=[①-⑳])/gm, "");
    value = value.split(/(\n[ \t]*\n)/).map((paragraph) => {
      const count = paragraph.match(/[①-⑳]/g)?.length ?? 0;
      const pattern = count > 1 ? /[ \t]*([①-⑳])[ \t]*/g : /(?<=^|[:：])[ \t]*([①-⑳])[ \t]*/g;
      return paragraph.replace(pattern, (_whole, marker, offset) => (offset === 0 || paragraph[offset - 1] === "\n" ? "" : "\n") + marker + " ");
    }).join("");
    value = value.replace(/\n{3,}/g, "\n\n");
  }
  return value;
}
function protectCodeBlocks(text, token, inline) {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  const parts = [];
  let previous = 0;
  let match;
  while ((match = opening.exec(text)) !== null) {
    const delimiter = match[1];
    if (delimiter[0] === "`" && match[2].includes("`")) continue;
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
function renderMarkdown(text, maxChars = DEFAULT_MESSAGE_MAX_CHARS, layout = true) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a nonnegative safe integer");
  }
  const pattern = /(?:(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)|(!)?\[([^\]\n]+)\]\(([^)\n]+)\)|(https?:\/\/[^\s<>`]+)|((?<![\w*])(?:~?\/|\.{1,2}\/|[A-Za-z]:\\)[^\s<>`]+))/gm;
  const opaque = [];
  let tokenPrefix = "\uE000wechat:";
  while (text.includes(tokenPrefix)) tokenPrefix += ":";
  const token = (value) => {
    const index = opaque.push(value) - 1;
    return `${tokenPrefix}${index}\uE001`;
  };
  const inline = (value) => value.replace(pattern, (_whole, delimiter, code, isImage, linkLabel, linkUrl, bareUrl, path) => {
    if (delimiter !== void 0) return token(code);
    if (isImage !== void 0) return token(prose(linkLabel, layout));
    if (linkLabel !== void 0 && linkUrl !== void 0) {
      const label = prose(linkLabel, layout);
      return token(layout ? label + " (" + linkUrl + ")" : label + ": " + linkUrl);
    }
    return token(bareUrl ?? path);
  });
  const protectedText = protectCodeBlocks(text, token, inline);
  const formatted = prose(protectedText, layout).trim();
  const rendered = formatted.replace(
    new RegExp(tokenPrefix + "(\\d+)\uE001", "g"),
    (_whole, index) => opaque[Number(index)]
  );
  if (rendered.length <= maxChars) {
    return rendered;
  }
  if (maxChars === 0) {
    return "";
  }
  const notice = maxChars >= TRUNCATION_NOTICE.length ? TRUNCATION_NOTICE : "\u2026";
  const end = unicodeSafeBoundary(rendered, maxChars - notice.length);
  return rendered.slice(0, end) + notice;
}
function markdownToWeChat(text, maxChars = DEFAULT_MESSAGE_MAX_CHARS) {
  return renderMarkdown(text, maxChars, true);
}
function markdownForWeChat(text, maxChars = DEFAULT_MESSAGE_MAX_CHARS) {
  return renderMarkdown(text, maxChars, false);
}
export {
  DEFAULT_MESSAGE_MAX_CHARS,
  TRUNCATION_NOTICE,
  markdownForWeChat,
  markdownToWeChat,
  renderMarkdown,
  unicodeSafeBoundary
};
