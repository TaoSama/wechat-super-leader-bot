import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postcss, { type Rule } from "postcss";
import { expect, it } from "vitest";

const sourceDirectory = resolve(process.cwd(), "src");
const entrySource = readFileSync(resolve(sourceDirectory, "main.tsx"), "utf8");
const cssImports = [...entrySource.matchAll(/^import ["'](.+\.css)["'];$/gm)].map(match => match[1]);
if (!cssImports.length) throw new Error("Missing application stylesheet imports");
function loadStylesheet(path: string): string {
  return readFileSync(path, "utf8").replace(/^@import ["'](.+\.css)["'];$/gm,
    (_match, imported: string) => loadStylesheet(resolve(dirname(path), imported)));
}
const stylesheet = postcss.parse(cssImports.map(path => loadStylesheet(resolve(sourceDirectory, path))).join("\n"));
const rule = (selector: string) => {
  const found = stylesheet.nodes.find(node => node.type === "rule" && node.selectors.includes(selector));
  if (!found || found.type !== "rule") throw new Error(`Missing filter rule: ${selector}`);
  return found;
};
const declarations = (rule: Rule) => Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value]));

it("桌面筛选触发器为32px紧凑控件，不填满剩余宽度或被flex拉伸", () => {
  expect(declarations(rule(".filter-select"))).toMatchObject({
    "min-height": "32px", "min-width": "44px", "max-width": "180px", width: "auto", flex: "0 1 auto",
    "align-self": "center", "line-height": "20px", padding: "4px 8px",
  });
  expect(declarations(rule(".status-filter .filter-select"))["max-width"]).toBe("156px");
  expect(stylesheet.nodes.some(node => node.type === "rule" && node.selector === ".machine-filter select")).toBe(false);
});

it("小屏和粗指针筛选保持44px触摸高度，横屏触摸设备也不缩小点击区", () => {
  const touch = stylesheet.nodes.find(node => node.type === "atrule" && node.name === "media" && node.params === "(max-width: 719px), (pointer: coarse)");
  if (!touch || touch.type !== "atrule") throw new Error("Missing touch filter media rule");
  const control = touch.nodes?.find(node => node.type === "rule" && node.selector === ".filter-select");
  if (!control || control.type !== "rule") throw new Error("Missing touch filter control rule");
  expect(declarations(control)).toMatchObject({ "min-height": "44px", "padding-block": "10px" });
});

it("键盘筛选触发器保留清晰焦点，节点筛选选中样式不增加尺寸", () => {
  const focus = stylesheet.nodes.find(node => node.type === "rule" && node.selectors.includes("button:focus-visible"));
  if (!focus || focus.type !== "rule") throw new Error("Missing filter trigger keyboard focus rule");
  expect(declarations(focus)).toMatchObject({ outline: "3px solid var(--accent-teal)", "outline-offset": "3px" });
  for (const property of ["padding", "width", "height", "min-height", "transform"]) {
    expect(declarations(rule(".node-card.selected"))).not.toHaveProperty(property);
  }
});

it.each([
  ".receipt-details > summary",
  ".send-receipt summary",
  ".machine-details > summary",
  ".command-history > summary",
  ".command-details summary",
  ".leader-mode-help summary",
  ".leader-footnote summary",
])("折叠入口%s保持至少44px触摸高度，响应式规则不能缩小", (selector) => {
  const minimumTouchHeight = 44;
  const assertTouchHeight = (height: string) => {
    expect(height).toMatch(/^\d+(?:\.\d+)?px$/);
    expect(Number.parseFloat(height)).toBeGreaterThanOrEqual(minimumTouchHeight);
  };
  assertTouchHeight(declarations(rule(selector))["min-height"]);
  stylesheet.walkRules(candidate => {
    if (!candidate.selectors.includes(selector)) return;
    const height = declarations(candidate)["min-height"];
    if (height !== undefined) assertTouchHeight(height);
  });
});
