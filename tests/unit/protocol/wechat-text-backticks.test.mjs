import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { markdownForWeChat, markdownToWeChat } from "../../../packages/wechat-text/index.js";

const RENDERERS = [markdownToWeChat, markdownForWeChat];
const FULL_SOURCE_BUDGET = Number.MAX_SAFE_INTEGER;
const WORKER_TIMEOUT_MS = 10_000;

// Retain the former regex as a bounded oracle for inputs without other Markdown.
function legacyInlineCode(source) {
  const values = [];
  const protectedText = source.replace(/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g,
    (_whole, _delimiter, contents) => `\uE000${values.push(contents) - 1}\uE001`);
  return protectedText.trim().replace(/\uE000(\d+)\uE001/g, (_whole, index) => values[Number(index)]);
}

test("indexed backtick scanning matches the former regex for exact runs and multiline nesting", () => {
  const fragments = ["a", " ", "\nx", "\rx", "a `", "a ``", "a ```", "a ````", "a `````"];
  let state = 0x1A2B3C4D;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let sample = 0; sample < 3_000; sample++) {
    // Every run has prose before it so fenced blocks do not affect this oracle.
    let source = "prose ";
    const count = next() % 40;
    for (let index = 0; index < count; index++) source += fragments[next() % fragments.length];
    const expected = legacyInlineCode(source);
    for (const render of RENDERERS) {
      assert.equal(render(source, FULL_SOURCE_BUDGET), expected, JSON.stringify(source));
    }
  }
});

test("code, links and bare URLs retain precedence when a link consumes a potential opener", () => {
  const examples = [
    ["[label `first](url) second` tail `third`", "label `first (url) second tail third`", "label `first: url second tail third`"],
    ["`[inside](url)` [outside](dest)", "[inside](url) outside (dest)", "[inside](url) outside: dest"],
    ["[a](http://a`x) tail `z`", "a (http://a`x) tail z", "a: http://a`x tail z"],
    ["a``x`y```z``tail`end`", "ax`y```ztailend", "ax`y```ztailend"],
    ["http://example.com/a`**literal**` trailing", "http://example.com/a**literal** trailing", "http://example.com/a**literal** trailing"],
    ["a `first [label `](dest) x` next`", "a first [label ](dest) x next", "a first [label ](dest) x next"],
  ];
  for (const [source, display, compact] of examples) {
    assert.equal(markdownToWeChat(source, FULL_SOURCE_BUDGET), display);
    assert.equal(markdownForWeChat(source, FULL_SOURCE_BUDGET), compact);
  }
});

test("long matched code retains exact delimiter lengths, nested runs and all contents", () => {
  const delimiter = "`".repeat(4_000);
  const contents = "  **literal** ` nested `` 🚀\n".repeat(500) + "  tail";
  for (const render of RENDERERS) {
    assert.equal(render("a " + delimiter + contents + delimiter, FULL_SOURCE_BUDGET), "a " + contents);
    assert.equal(render("a " + delimiter + " **ordinary** " + "`".repeat(4_001), FULL_SOURCE_BUDGET),
      "a " + delimiter + " ordinary " + "`".repeat(4_001));
  }
});

test("distinct unmatched backtick runs scale to the supported result size in a bounded worker", (t) => {
  const moduleUrl = new URL("../../../packages/wechat-text/index.js", import.meta.url).href;
  const script = `
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { markdownToWeChat, markdownForWeChat } from ${JSON.stringify(moduleUrl)};
const timings = [];
for (const count of [1_000, 2_000, 4_000]) {
  const source = Array.from({ length: count }, (_, index) => "a" + "\u0060".repeat(index + 1)).join(" ");
  assert.ok(source.length < 8 * 1024 * 1024);
  const started = performance.now();
  for (const render of [markdownToWeChat, markdownForWeChat]) {
    assert.equal(render(source, Number.MAX_SAFE_INTEGER), source);
  }
  timings.push({ count, chars: source.length, ms: performance.now() - started });
}
console.log(JSON.stringify(timings));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: WORKER_TIMEOUT_MS,
  });
  assert.equal(result.error, undefined, result.error?.message ?? "");
  assert.equal(result.status, 0, result.stderr);
  t.diagnostic(result.stdout.trim());
});
