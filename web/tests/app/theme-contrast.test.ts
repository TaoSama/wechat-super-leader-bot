import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss, { type Rule } from "postcss";
import { expect, it } from "vitest";

const styles = (name: string) => postcss.parse(readFileSync(resolve(process.cwd(), "src/styles", name), "utf8"));
const appearance = styles("appearance.css");
function declarations(rule: Rule) { return Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value])); }
function themeTokens(theme: "light" | "dark") {
  const rule = appearance.nodes.find(node => node.type === "rule" && node.selectors.includes(`.app-shell[data-theme="${theme}"]`));
  if (!rule || rule.type !== "rule") throw new Error(`Missing ${theme} theme`);
  return declarations(rule);
}
function rgb(value: string): number[] {
  const hex = value.slice(1);
  const full = hex.length === 3 ? [...hex].map(character => character.repeat(2)).join("") : hex;
  return [0, 2, 4].map(offset => Number.parseInt(full.slice(offset, offset + 2), 16));
}
function luminance(color: number[]) {
  const linear = color.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
function contrast(foreground: number[], background: number[]) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

it.each(["light", "dark"] as const)("%s 成功文字在实际状态底色与工作区底色达到4.5:1", theme => {
  const tokens = themeTokens(theme);
  const foreground = rgb(tokens["--status-success"]);
  const surface = rgb(tokens["--surface-0"]);
  const accent = rgb(tokens["--accent"]);
  const badge = accent.map((channel, index) => channel * .1 + surface[index] * .9);
  for (const background of [badge, surface, rgb(tokens["--surface-1"]), rgb(tokens["--sidebar"])]) {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  }
});

it("状态成功颜色独立于品牌色，并覆盖所有成功pill与在线/回执文字", () => {
  const controls = styles("controls.css");
  for (const selector of [".status-badge.status-completed", ".status-badge.status-accepted", ".status-badge.status-active"]) {
    const rule = controls.nodes.find(node => node.type === "rule" && node.selectors.includes(selector));
    if (!rule || rule.type !== "rule") throw new Error(`Missing ${selector}`);
    expect(declarations(rule).color).toBe("var(--status-success)");
  }
  for (const [file, selector] of [["base.css", ".online"], ["shell.css", ".header-connection"], ["feedback.css", ".send-receipt > span"]]) {
    const rule = styles(file).nodes.find(node => node.type === "rule" && node.selectors.includes(selector));
    if (!rule || rule.type !== "rule") throw new Error(`Missing ${selector}`);
    expect(declarations(rule).color).toBe("var(--status-success)");
  }
  expect(themeTokens("light")["--accent-bright"]).toBe("#239956");
  expect(themeTokens("dark")["--accent-bright"]).toBe("#7ccba0");
});
