import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { legacyWeChatCitationBody, markdownToWeChat, TRUNCATION_NOTICE, DEFAULT_MESSAGE_MAX_CHARS } from "../../src/wechat/markdown.js";
import { splitWeChatReply } from "../../src/wechat/client.js";

test("default reply chunks use a 3800 UTF-16-unit budget and preserve full source", () => {
  assert.equal(DEFAULT_MESSAGE_MAX_CHARS, 3800);
  const source = "中".repeat(DEFAULT_MESSAGE_MAX_CHARS - 1) + "🚀" + " end\n  **原文**\n";
  const chunks = splitWeChatReply(source);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), source);
  assert.equal(chunks[0].length, DEFAULT_MESSAGE_MAX_CHARS - 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= DEFAULT_MESSAGE_MAX_CHARS);
    assert.equal(Buffer.from(chunk, "utf8").toString("utf8"), chunk);
  }
  assert.deepEqual(splitWeChatReply("🚀".repeat(DEFAULT_MESSAGE_MAX_CHARS / 2)), ["🚀".repeat(DEFAULT_MESSAGE_MAX_CHARS / 2)]);
});

test("markdownToWeChat strips headers, bullets, and converts links with layout", () => {
  const source = "# 标题\n\n**重点** 与 `代码`\n- 一项\n[文档](https://example.com)";
  const expected = "标题\n\n重点 与 代码\n• 一项\n文档 (https://example.com)";
  assert.equal(markdownToWeChat(source), expected);
});

test("markdownToWeChat keeps citation-looking text while rendering Markdown and URLs", () => {
  const token = "\uE200cite\uE202turn6search1\uE201";
  const source = `正文 ${token} [文档](https://example.com/docs) https://example.com/raw`;
  assert.equal(markdownToWeChat(source), `正文 ${token} 文档 (https://example.com/docs) https://example.com/raw`);
});

test("legacy citation reconstruction only removes ordinary tokens", () => {
  const token = "\uE200cite\uE202turn6search1\uE201";
  const source = `前${token}后 \`代码 ${token}\` [文档 ${token}](https://example.com/${token}) https://example.com/raw-${token}`;
  assert.equal(legacyWeChatCitationBody(source),
    `前后 \`代码 ${token}\` [文档 ${token}](https://example.com/${token}) https://example.com/raw-${token}`);
});

test("preserves technical identifiers and inline code", () => {
  assert.equal(markdownToWeChat("model_catalog_json ~/.codex/*.json a_b_c"), "model_catalog_json ~/.codex/*.json a_b_c");
  assert.equal(markdownToWeChat("`x = a * b; path = '~/my_dir'; **kwargs`"), "x = a * b; path = '~/my_dir'; **kwargs");
});

test("phone session summary separates numbered sessions and formerly glued headings", () => {
  const source = "看到了，目前 2 台机器在线，共观测到24个会话：3个运行中、10个空闲。\n\n"
    + "- 正在运行的3个都在 MacAir：\n"
    + "- ①「跨机定时任务」— GPT-6-Astra ②「可靠通知交付」— GPT-6.1-Sol ③「记忆接入主控」— GPT-6.1-Sol**空闲会话包括：\n\n**\n\n"
    + "- CPA测速、Pulse应用部署、市场研究主控。 **其他已看到的会话包括：\n\n**\n\n运行状态来自 Codex 桌面观测。";
  assert.equal(markdownToWeChat(source), "看到了，目前 2 台机器在线，共观测到24个会话：3个运行中、10个空闲。\n\n"
    + "• 正在运行的3个都在 MacAir：\n① 「跨机定时任务」— GPT-6-Astra\n② 「可靠通知交付」— GPT-6.1-Sol\n③ 「记忆接入主控」— GPT-6.1-Sol\n\n空闲会话包括：\n\n"
    + "• CPA测速、Pulse应用部署、市场研究主控。 \n\n其他已看到的会话包括：\n\n运行状态来自 Codex 桌面观测。");
});

test("emphasis handles word-adjacent stars and multiline content without leaking delimiters", () => {
  assert.equal(markdownToWeChat("GPT**运行中**Sol，中文**重点**中文，**第一行\n第二行**。"), "GPT运行中Sol，中文重点中文，第一行\n第二行。");
  assert.equal(markdownToWeChat("**结果：**\n**`codex run`**\n**\n完成"), "结果：\ncodex run\n完成");
  assert.equal(markdownToWeChat("**跨行结束\n**\n正文"), "跨行结束\n\n正文");
  assert.equal(markdownToWeChat("①任务A②任务B③任务C"), "① 任务A\n② 任务B\n③ 任务C");
  assert.equal(markdownToWeChat("普通正文提到①标识"), "普通正文提到①标识");
});

test("formatting keeps URL tokens, paths, arithmetic and opaque code contents", () => {
  const technical = "~/.codex/*.json /tmp/**/cache /tmp/foo**bar**baz C:\\my_dir\\**\\a_b 2 * 3 * 4 a_b_c 中文_标识_中文";
  assert.equal(markdownToWeChat(technical), technical);
  assert.equal(markdownToWeChat("**/tmp/report.json**"), "/tmp/report.json");
  assert.equal(markdownToWeChat("**`a ** b * c`**"), "a ** b * c");
  assert.equal(markdownToWeChat("**[官网](https://example.com/a_b?q=__secret__)**"), "官网 (https://example.com/a_b?q=__secret__)");
  assert.equal(markdownToWeChat("```text\n①原样②原样\n**原样**\n```\n①甲②乙"), "①原样②原样\n**原样**\n\n① 甲\n② 乙");
});

test("display formatting preserves the complete long response when given the full-source budget", () => {
  const source = "**完整成果**\n" + "保留每一行🚀\n".repeat(900);
  const rendered = markdownToWeChat(source, Number.MAX_SAFE_INTEGER);
  assert.equal(rendered, "完整成果\n" + "保留每一行🚀\n".repeat(900).trimEnd());
  assert.equal(splitWeChatReply(rendered).join(""), rendered);
  assert.ok(rendered.length > DEFAULT_MESSAGE_MAX_CHARS);
  assert.ok(!rendered.includes(TRUNCATION_NOTICE));
});

test("emphasis spans the complete three-message result and preserves multiline closing whitespace", () => {
  const body = "甲".repeat(DEFAULT_MESSAGE_MAX_CHARS * 3);
  assert.equal(markdownToWeChat("**" + body + "**", Number.MAX_SAFE_INTEGER), body);
  assert.equal(markdownToWeChat("__" + body + "__", Number.MAX_SAFE_INTEGER), body);
  assert.equal(markdownToWeChat("**首段\r\n\r\n末段 \t\r\n \t**后文", Number.MAX_SAFE_INTEGER), "首段\r\n\r\n末段 \t\r\n \t后文");
  assert.equal(markdownToWeChat("*x ".repeat(20_000), Number.MAX_SAFE_INTEGER), "*x ".repeat(20_000).trimEnd());
  assert.equal(markdownToWeChat("*/x ".repeat(20_000), Number.MAX_SAFE_INTEGER), "*/x ".repeat(20_000).trimEnd());
  assert.equal(markdownToWeChat("_x ".repeat(20_000), Number.MAX_SAFE_INTEGER), "_x ".repeat(20_000).trimEnd());
});

test("large unmatched emphasis finishes within a bounded worker instead of rescanning every suffix", () => {
  const moduleUrl = import.meta.resolve("@super-leader/wechat-text");
  const script = `import assert from 'node:assert/strict';
import { markdownToWeChat } from ${JSON.stringify(moduleUrl)};
for (const fragment of ['*x ', '*/x ', '_x ']) {
  const source = fragment.repeat(200_000);
  assert.equal(markdownToWeChat(source, Number.MAX_SAFE_INTEGER), source.trimEnd());
}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr);
});

test("preserves fenced code block contents without backticks", () => {
  const source = "```python\n# comment\n-1\nx = a_b * 2\nprint('**literal**')\n```";
  const expected = "# comment\n-1\nx = a_b * 2\nprint('**literal**')\n";
  assert.equal(markdownToWeChat(source), expected);
});

test("code at display boundaries retains its indentation, trailing whitespace and blank lines", () => {
  const contents = "  return 1  \n\tcall()\n\n";
  const fenced = "```python\n" + contents + "```";
  assert.equal(markdownToWeChat(fenced), contents);
  assert.equal(markdownToWeChat("\n\n" + fenced + "\n\n"), contents);
  assert.equal(markdownToWeChat(fenced + "\n正文"), contents + "\n正文");
  assert.equal(markdownToWeChat("正文\n" + fenced), "正文\n" + contents);
  assert.equal(markdownToWeChat("`  return 1  `"), "  return 1  ");
});

test("inline code matches equal backtick runs and preserves shorter and longer runs inside", () => {
  assert.equal(markdownToWeChat("``a ` b``"), "a ` b");
  assert.equal(markdownToWeChat("``a ``` b``"), "a ``` b");
  assert.equal(markdownToWeChat("````  a `` b ` c  ````"), "  a `` b ` c  ");
  assert.equal(markdownToWeChat("**``a ` **literal** b``**"), "a ` **literal** b");
  assert.equal(markdownToWeChat("未闭合 ``原样 `"), "未闭合 ``原样 `");
});

test("backtick and tilde code fences protect contents using the opening run and indentation", () => {
  const contents = "# literal heading\n- literal item\n**literal**\n  return 1  \n";
  for (const opening of ["```", "````", "~~~", "~~~~"]) {
    for (const indentation of ["", " ", "  ", "   "]) {
      assert.equal(markdownToWeChat(indentation + opening + "python\n" + contents + indentation + opening), contents);
      assert.equal(markdownToWeChat(indentation + opening + "python\n" + contents + indentation + opening + opening[0]), contents);
      assert.equal(markdownToWeChat(indentation + opening + "python\n" + contents), contents);
    }
  }
  assert.equal(markdownToWeChat("````python\n```\n# literal\n~~~\n````"), "```\n# literal\n~~~\n");
  assert.equal(markdownToWeChat("~~~python\n```\n# literal\n~~\n~~~"), "```\n# literal\n~~\n");
  assert.equal(markdownToWeChat("~~~python\n# literal\n~~~~ trailing text\n- literal"), "# literal\n~~~~ trailing text\n- literal");
  assert.equal(markdownToWeChat("~~~python\r\n  return 1\r\n~~~"), "  return 1\r\n");
});

test("surrounding prose still formats when an unmatched inline delimiter precedes a code fence", () => {
  assert.equal(markdownToWeChat("**前言** `\n~~~python\n# literal\n- literal\n~~~\n**后文**"),
    "前言 `\n# literal\n- literal\n\n后文");
  assert.equal(markdownToWeChat("```python\n# literal\n- literal"), "# literal\n- literal");
  assert.equal(markdownToWeChat("~~~"), "");
});

test("preserves link destination with special characters", () => {
  assert.equal(markdownToWeChat("[下载](https://example.com/a_b_c?q=~x)"), "下载 (https://example.com/a_b_c?q=~x)");
});

test("link scanning preserves nested labels, image labels, malformed destinations and code precedence", () => {
  assert.equal(markdownToWeChat("[[说明](https://example.com)"), "[说明 (https://example.com)");
  assert.equal(markdownToWeChat("![**图**](asset) 和 [文档](https://example.com)"), "图 和 文档 (https://example.com)");
  assert.equal(markdownToWeChat("`[代码` [说明](https://example.com)"), "[代码 说明 (https://example.com)");
  assert.equal(markdownToWeChat("[坏](无闭合\n[好](ok)"), "[坏](无闭合\n好 (ok)");
  assert.equal(markdownToWeChat("[坏](无闭合[另坏](仍无闭合"), "[坏](无闭合[另坏](仍无闭合");
  assert.equal(markdownToWeChat("[跨\r行](含\r字符)"), "跨\r行 (含\r字符)");
});

test("large unmatched labels and malformed destinations finish without retrying every opener", () => {
  const moduleUrl = import.meta.resolve("@super-leader/wechat-text");
  const script = `import assert from 'node:assert/strict';
import { markdownToWeChat } from ${JSON.stringify(moduleUrl)};
for (const fragment of ['[', '![', '[x](']) {
  const source = fragment.repeat(200_000);
  assert.equal(markdownToWeChat(source, Number.MAX_SAFE_INTEGER), source);
}
const followedByBadUrl = '['.repeat(200_000) + 'x](unterminated';
assert.equal(markdownToWeChat(followedByBadUrl, Number.MAX_SAFE_INTEGER), followedByBadUrl);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr);
});

test("adjacent valid URL and path links avoid eagerly consuming each remaining destination suffix", () => {
  const moduleUrl = import.meta.resolve("@super-leader/wechat-text");
  const script = `import assert from 'node:assert/strict';
import { markdownToWeChat } from ${JSON.stringify(moduleUrl)};
for (const [source, display] of [
  ['[x](http://a)', 'x (http://a)'],
  ['[x](/tmp/a)', 'x (/tmp/a)'],
  ['![x](http://a)', 'x'],
]) {
  const repetitions = 64_000;
  assert.equal(markdownToWeChat(source.repeat(repetitions), Number.MAX_SAFE_INTEGER), display.repeat(repetitions));
}`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr);
});

test("preserves one-time login credentials in bare URLs exactly", () => {
  const tokens = ["_" + "a".repeat(41) + "_", "a-_" + "b".repeat(36) + "_-cd"];
  for (const token of tokens) {
    assert.equal(token.length, 43);
    const url = `https://leader.example/#login=${token}`;
    const source = `**控制台**\n${url}\n\n_不要转发_`;
    const rendered = markdownToWeChat(source);
    assert.equal(rendered, `控制台\n${url}\n\n不要转发`);
    assert.equal(splitWeChatReply(rendered, 100).join(""), rendered);
  }
});

test("truncation notice respects maxChars limit", () => {
  const longText = "中".repeat(5000);
  const truncated = markdownToWeChat(longText, DEFAULT_MESSAGE_MAX_CHARS);
  assert.equal(truncated.length, DEFAULT_MESSAGE_MAX_CHARS);
  assert.ok(truncated.endsWith(TRUNCATION_NOTICE));

  const shortTrunc = markdownToWeChat(longText, 5);
  assert.equal(shortTrunc.length, 5);
  assert.ok(shortTrunc.endsWith("…"));

  assert.equal(markdownToWeChat(longText, 0), "");
  assert.throws(() => markdownToWeChat(longText, -1), RangeError);
});

test("truncation never splits emoji surrogate pairs at any budget boundary", () => {
  const source = "开始🚀👩‍💻完成".repeat(20);
  for (let budget = 0; budget <= source.length + 1; budget++) {
    const result = markdownToWeChat(source, budget);
    assert.ok(result.length <= budget);
    assert.equal(Buffer.from(result, "utf8").toString("utf8"), result);
  }
  assert.equal(markdownToWeChat("🚀🚀", 2), "…");
  assert.equal(markdownToWeChat("🚀🚀", 3), "🚀…");
  assert.equal(markdownToWeChat("🚀🚀", 4), "🚀🚀");
});

test("rejects non-integer and non-finite message budgets", () => {
  for (const budget of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => markdownToWeChat("text", budget), RangeError);
    assert.throws(() => splitWeChatReply("text", budget), RangeError);
  }
});

test("multipart replies preserve all emoji without splitting surrogate pairs", () => {
  const source = "状态🚀👩‍💻执行中".repeat(20);
  for (let budget = 2; budget < 40; budget++) {
    const chunks = splitWeChatReply(source, budget);
    assert.equal(chunks.join(""), source);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= budget);
      assert.equal(Buffer.from(chunk, "utf8").toString("utf8"), chunk);
    }
  }
  assert.throws(() => splitWeChatReply("🚀", 1), RangeError);
  assert.throws(() => splitWeChatReply("text", 0), RangeError);
  assert.deepEqual(splitWeChatReply("ab", 1), ["a", "b"]);
});

test("multipart replies preserve code indentation, blank lines and spaces exactly", () => {
  const source = "if ready:\n    run()\n\n    report('完成🚀')\n";
  for (let budget = 2; budget <= source.length + 1; budget++) {
    const chunks = splitWeChatReply(source, budget);
    assert.equal(chunks.join(""), source, `content changed at budget ${budget}`);
    assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= budget));
    for (const chunk of chunks) {
      assert.equal(Buffer.from(chunk, "utf8").toString("utf8"), chunk);
    }
  }
  assert.equal(splitWeChatReply(" \n\t", 2).join(""), " \n\t");
});
