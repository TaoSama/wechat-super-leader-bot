const DEFAULT_MESSAGE_MAX_CHARS = 3800;
const TRUNCATION_NOTICE = "\n\n[\u5185\u5BB9\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD]";
const DIRECTORY_NOUN = "(?:会话|任务|sessions?|tasks?|agents?)";
const DIRECTORY_STATUS = "(?<status>运行中(?:的)?|正在运行(?:的)?|活跃(?:的)?|空闲(?:的)?)?";
const DIRECTORY_SCOPE = "(?:(?:当前|现在)(?:的)?)?(?:(?:所有|全部)(?:的)?)?(?:都)?(?:有哪些)?";
const DIRECTORY_QUERY_PATTERNS = [
  new RegExp(`^(?:请)?(?:帮我|给我)?(?:查看|查询|列出|看看|看一下|看下|查一下|查下|展示|显示)(?:我)?${DIRECTORY_SCOPE}${DIRECTORY_STATUS}${DIRECTORY_NOUN}(?:列表)?[？?。!！]?$`, "iu"),
  new RegExp(`^(?:(?:当前|现在))?(?:都)?有哪些${DIRECTORY_STATUS}${DIRECTORY_NOUN}[？?。!！]?$`, "iu"),
  new RegExp(`^${DIRECTORY_SCOPE}${DIRECTORY_STATUS}${DIRECTORY_NOUN}列表[？?。!！]?$`, "iu"),
];
const CONSOLE_LINK_QUERY = /^(?:请)?(?:(?:给我|发我|提供|获取|帮我获取)(?:一个|一下)?(?:控制台|控制端)(?:登录)?(?:链接|入口)|(?:打开|访问)(?:一下)?(?:控制台|控制端)(?:登录)?(?:页面|链接|入口)?|(?:控制台|控制端)(?:登录)?(?:链接|入口))[？?。!！]?$/u;
/** Only standalone directory requests bypass native reasoning; any extra intent falls through. */
function parseSessionDirectoryQuery(text) {
  if (typeof text !== "string" || /[\r\n\u2028\u2029]/u.test(text)) return undefined;
  const normalized = text.trim().replace(/[ \t]+/gu, "");
  for (const pattern of DIRECTORY_QUERY_PATTERNS) {
    const match = pattern.exec(normalized);
    if (!match) continue;
    const status = match.groups?.status;
    return status ? { status: status.startsWith("空闲") ? "idle" : "active" } : {};
  }
  return undefined;
}
/** A console request must not silently absorb any other task or delivery instruction. */
function isConsoleLinkQuery(text) {
  return typeof text === "string" && !/[\r\n\u2028\u2029]/u.test(text) &&
    CONSOLE_LINK_QUERY.test(text.trim().replace(/[ \t]+/gu, ""));
}
function unicodeSafeBoundary(text, end) {
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return last >= 55296 && last <= 56319 && next >= 56320 && next <= 57343 ? end - 1 : end;
}
function precedingCharacter(text, offset) {
  const last = text.charCodeAt(offset - 1);
  const previous = text.charCodeAt(offset - 2);
  const width = last >= 56320 && last <= 57343 && previous >= 55296 && previous <= 56319 ? 2 : 1;
  return text.slice(Math.max(0, offset - width), offset);
}
function emphasisHasContent(text, closing, contentStart, strong) {
  let end = closing - 1;
  if (end >= contentStart && !/\s/u.test(text[end])) return true;
  if (!strong) return false;
  // Malformed strong closers may occupy the next line. Inspect each whitespace gap once.
  while (end >= contentStart && (text[end] === " " || text[end] === "\t")) end--;
  if (text[end] !== "\n") return false;
  end--;
  if (text[end] === "\r") end--;
  while (end >= contentStart && (text[end] === " " || text[end] === "\t")) end--;
  return end >= contentStart && !/\s/u.test(text[end]);
}
function stripEmphasis(text, marker, boundary, strong = false) {
  const parts = [];
  let previous = 0;
  let opening = -1;
  let cursor = 0;
  // Keep the earliest valid opener. Any later closer valid for another opener is also valid
  // for this one, so an unmatched opener never requires rescanning the remaining input.
  for (let at; (at = text.indexOf(marker, cursor)) !== -1; ) {
    const after = at + marker.length;
    if (opening !== -1 && !boundary.test(String.fromCodePoint(text.codePointAt(after) ?? 0)) &&
        emphasisHasContent(text, at, opening + marker.length, strong)) {
      if (previous < opening) parts.push(text.slice(previous, opening));
      parts.push(text.slice(opening + marker.length, at));
      previous = after;
      opening = -1;
      cursor = after;
      continue;
    }
    if (opening === -1 && after < text.length && !boundary.test(precedingCharacter(text, at)) && !/\s/u.test(text[after]))
      opening = at;
    cursor = at + 1;
  }
  parts.push(text.slice(previous));
  return parts.join("");
}
function prose(value) {
  value = value.replace(
    /(?:\*\*|__)([^\n*]{1,80}[:：])[ \t]*(?:(?:\r?\n[ \t]*)*(?:\*\*|__)|(?=\n|[①-⑳]|$))/g,
    (whole, heading, offset) => {
      const before = value.slice(0, offset);
      const after = value.slice(offset + whole.length);
      return (before && !before.endsWith("\n") ? "\n\n" : "") + heading + (after.startsWith("\n") ? "" : "\n");
    }
  );
  const markers = [
    { marker: "**", boundary: /[*/\\]/u, strong: true },
    { marker: "__", boundary: /[\p{L}\p{N}_/\\]/u, strong: true },
    { marker: "~~", boundary: /[~/\\]/u },
    { marker: "*", boundary: /[*/\\]/u },
    { marker: "_", boundary: /[\p{L}\p{N}_/\\]/u }
  ];
  for (const { marker, boundary, strong } of markers) {
    value = stripEmphasis(value, marker, boundary, strong);
  }
  value = value.replace(/^[ \t]*(?:\*\*|__)[ \t]*(?:\r?\n|$)/gm, "");
  value = value.replace(/^#{1,6}[ \t]+(.+)$/gm, "$1");
  value = value.replace(/^[ \t]*[-+*][ \t]+/gm, "\u2022 ");
  value = value.replace(/^•[ \t]+(?=[①-⑳])/gm, "");
  value = value.split(/(\n[ \t]*\n)/).map((paragraph) => {
    const count = paragraph.match(/[①-⑳]/g)?.length ?? 0;
    const pattern = count > 1 ? /[ \t]*([①-⑳])[ \t]*/g : /(?<=^|[:：])[ \t]*([①-⑳])[ \t]*/g;
    return paragraph.replace(pattern, (_whole, marker, offset) => (offset === 0 || paragraph[offset - 1] === "\n" ? "" : "\n") + marker + " ");
  }).join("");
  value = value.replace(/\n{3,}/g, "\n\n");
  return value;
}
function protectCodeBlocks(text, token, inline, preserveDelimiters = false) {
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
    parts.push(inline(text.slice(previous, match.index)), token(preserveDelimiters
      ? text.slice(match.index, end ? closing.lastIndex : text.length)
      : text.slice(contentStart, end?.index ?? text.length)));
    previous = end ? closing.lastIndex : text.length;
    opening.lastIndex = previous;
    if (!end) break;
  }
  parts.push(inline(text.slice(previous)));
  return parts.join("");
}
function scanLinks(text) {
  const candidates = [];
  let openings = [];
  // A label ends at its first closing bracket or newline. Keep nested openers so code
  // that consumes an earlier opener still leaves the next label available, without rescanning.
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "[") openings.push(at);
    else if (text[at] === "]" || text[at] === "\n") {
      if (text[at] === "]" && openings.length && at > openings[0] + 1 && text[at + 1] === "(")
        candidates.push({ openings, openingIndex: 0, labelEnd: at });
      openings = [];
    }
  }
  let cursor = text.length - 1;
  let nextParenthesis = text.length;
  let nextNewline = text.length;
  // Check all destinations with one reverse scan. A malformed destination may contain
  // another label, so consuming the whole failed destination would change the output.
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    const destinationStart = candidate.labelEnd + 2;
    for (; cursor >= destinationStart; cursor--) {
      if (text[cursor] === ")") nextParenthesis = cursor;
      else if (text[cursor] === "\n") nextNewline = cursor;
    }
    if (nextParenthesis < nextNewline && nextParenthesis > destinationStart) candidate.end = nextParenthesis + 1;
  }
  return candidates.filter(candidate => candidate.end !== void 0);
}
function scanCodeSpans(text) {
  const spans = [];
  const nextByLength = new Map();
  // Index complete runs once. The first following run of exactly the same length
  // closes an opener; different lengths remain literal content inside that span.
  for (let at = text.length - 1; at >= 0; at--) {
    if (text[at] !== "`") continue;
    const end = at + 1;
    while (at >= 0 && text[at] === "`") at--;
    const start = at + 1;
    const length = end - start;
    const closing = nextByLength.get(length);
    if (closing) spans.push({ start, contentStart: end, contentEnd: closing.start, end: closing.end });
    nextByLength.set(length, { start, end });
  }
  return spans.reverse();
}
function protectInline(text, pattern, token, expandMatch = true, preserveSyntax = false) {
  const links = scanLinks(text);
  const codeSpans = scanCodeSpans(text);
  const parts = [];
  let cursor = 0;
  let linkIndex = 0;
  let codeIndex = 0;
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (cursor < text.length) {
    let link;
    while (linkIndex < links.length) {
      const candidate = links[linkIndex];
      while (candidate.openingIndex < candidate.openings.length && candidate.openings[candidate.openingIndex] < cursor)
        candidate.openingIndex++;
      const opening = candidate.openings[candidate.openingIndex];
      if (opening === void 0 || opening + 1 >= candidate.labelEnd) {
        linkIndex++;
        continue;
      }
      const image = opening > cursor && text[opening - 1] === "!";
      link = { ...candidate, opening, start: image ? opening - 1 : opening };
      break;
    }
    while (codeIndex < codeSpans.length && codeSpans[codeIndex].start < cursor) codeIndex++;
    const code = codeSpans[codeIndex];
    const codeFirst = code && (!match || code.start < match.index);
    const nextStart = codeFirst ? code.start : match?.index;
    if (link && (nextStart === void 0 || link.start < nextStart)) {
      const label = prose(text.slice(link.opening + 1, link.labelEnd));
      const destination = text.slice(link.labelEnd + 2, link.end - 1);
      const displayed = link.start < link.opening ? label : label + " (" + destination + ")";
      parts.push(text.slice(cursor, link.start), token(preserveSyntax ? text.slice(link.start, link.end) : displayed));
      cursor = link.end;
    } else if (codeFirst) {
      parts.push(text.slice(cursor, code.start), token(preserveSyntax ? text.slice(code.start, code.end) :
        text.slice(code.contentStart, code.contentEnd)));
      cursor = code.end;
    } else if (match) {
      let end = pattern.lastIndex;
      const matched = text.slice(match.index, end);
      const shouldExpand = typeof expandMatch === "function" ? expandMatch(matched) : expandMatch;
      // URL/path matches extend to their complete token. Exact-match callers keep the
      // regular expression boundary so adjacent prose remains available for scanning.
      while (shouldExpand && end < text.length && !/[\s<>`]/u.test(text[end])) end++;
      parts.push(text.slice(cursor, match.index), token(text.slice(match.index, end)));
      cursor = end;
    } else break;
    // Retain lookahead beyond the consumed item, avoiding another search of that suffix.
    if (match && match.index < cursor) {
      pattern.lastIndex = cursor;
      match = pattern.exec(text);
    }
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}
const CITATION_TOKEN = /\uE200cite(?:\uE202[A-Za-z0-9._:-]+)+\uE201/gu;
const CITATION_SAFE_URL = /https?:\/\/(?=[^\s<>`])/gu;
function sanitizeWeChatCitations(text) {
  const opaque = [];
  let tokenPrefix = "\uE000wechat-citation:";
  while (text.includes(tokenPrefix)) tokenPrefix += ":";
  const token = (value) => {
    const index = opaque.push(value) - 1;
    return `${tokenPrefix}${index}\uE001`;
  };
  const inline = (value) => protectInline(value, CITATION_SAFE_URL, token, true, true);
  const protectedText = protectCodeBlocks(text, token, inline, true);
  let removedTokenCount = 0;
  let removedChars = 0;
  const sanitized = protectedText.replace(CITATION_TOKEN, whole => {
    removedTokenCount++;
    removedChars += whole.length;
    return "";
  });
  const restored = sanitized.replace(
    new RegExp(tokenPrefix + "(\\d+)\\uE001", "g"),
    (_whole, index) => opaque[Number(index)]
  );
  return { text: restored, removedTokenCount, removedChars };
}
function markdownToWeChat(text, maxChars = DEFAULT_MESSAGE_MAX_CHARS, sanitizeCitations = true) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a nonnegative safe integer");
  }
  const pattern = /(?:https?:\/\/(?=[^\s<>`])|(?<![\w*])(?:~?\/|\.{1,2}\/|[A-Za-z]:\\)(?=[^\s<>`]))/gm;
  const opaque = [];
  let tokenPrefix = "\uE000wechat:";
  while (text.includes(tokenPrefix)) tokenPrefix += ":";
  const token = (value) => {
    const index = opaque.push(value) - 1;
    return `${tokenPrefix}${index}\uE001`;
  };
  const inline = (value) => protectInline(value, pattern, token);
  const source = sanitizeCitations ? sanitizeWeChatCitations(text).text : text;
  const protectedText = protectCodeBlocks(source, token, inline);
  const formatted = prose(protectedText).trim();
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
export {
  DEFAULT_MESSAGE_MAX_CHARS,
  TRUNCATION_NOTICE,
  isConsoleLinkQuery,
  markdownToWeChat,
  sanitizeWeChatCitations,
  parseSessionDirectoryQuery,
  unicodeSafeBoundary
};
