import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToWeChat, markdownForWeChat, TRUNCATION_NOTICE, DEFAULT_MESSAGE_MAX_CHARS } from "../../src/wechat/markdown.js";
import { splitWeChatReply } from "../../src/wechat/client.js";

test("markdownToWeChat strips headers, bullets, and converts links with layout", () => {
  const source = "# 标题\n\n**重点** 与 `代码`\n- 一项\n[文档](https://example.com)";
  const expected = "标题\n\n重点 与 代码\n• 一项\n文档 (https://example.com)";
  assert.equal(markdownToWeChat(source), expected);
});

test("markdownForWeChat preserves label: url without layout change", () => {
  const source = "[文档](https://example.com)";
  assert.equal(markdownForWeChat(source), "文档: https://example.com");
});

test("preserves technical identifiers and inline code", () => {
  assert.equal(markdownToWeChat("model_catalog_json ~/.codex/*.json a_b_c"), "model_catalog_json ~/.codex/*.json a_b_c");
  assert.equal(markdownToWeChat("`x = a * b; path = '~/my_dir'; **kwargs`"), "x = a * b; path = '~/my_dir'; **kwargs");
});

test("preserves fenced code block contents without backticks", () => {
  const source = "```python\n# comment\n-1\nx = a_b * 2\nprint('**literal**')\n```";
  const expected = "# comment\n-1\nx = a_b * 2\nprint('**literal**')";
  assert.equal(markdownToWeChat(source), expected);
});

test("preserves link destination with special characters", () => {
  assert.equal(markdownToWeChat("[下载](https://example.com/a_b_c?q=~x)"), "下载 (https://example.com/a_b_c?q=~x)");
});

test("preserves one-time login credentials in bare URLs exactly", () => {
  const tokens = ["_" + "a".repeat(41) + "_", "a-_" + "b".repeat(36) + "_-cd"];
  for (const token of tokens) {
    assert.equal(token.length, 43);
    const url = `https://leader.example/#login=${token}`;
    const source = `**控制台**\n${url}\n\n_不要转发_`;
    for (const render of [markdownToWeChat, markdownForWeChat]) {
      const rendered = render(source);
      assert.equal(rendered, `控制台\n${url}\n\n不要转发`);
      assert.equal(splitWeChatReply(rendered, 100).join(""), rendered);
    }
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
  for (const render of [markdownToWeChat, markdownForWeChat]) {
    for (let budget = 0; budget <= source.length + 1; budget++) {
      const result = render(source, budget);
      assert.ok(result.length <= budget);
      assert.equal(Buffer.from(result, "utf8").toString("utf8"), result);
    }
    assert.equal(render("🚀🚀", 2), "…");
    assert.equal(render("🚀🚀", 3), "🚀…");
    assert.equal(render("🚀🚀", 4), "🚀🚀");
  }
});

test("rejects non-integer and non-finite message budgets", () => {
  for (const budget of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => markdownToWeChat("text", budget), RangeError);
    assert.throws(() => markdownForWeChat("text", budget), RangeError);
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
  assert.deepEqual(splitWeChatReply(" \n\t", 2), []);
});
