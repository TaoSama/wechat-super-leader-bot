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
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/iu.test(value)) throw new Error(`Unsupported hex color: ${value}`);
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

function ruleValue(sheet: ReturnType<typeof styles>, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const node of sheet.nodes) {
    if (node.type === "rule" && node.selectors.includes(selector)) {
      value = declarations(node)[property] ?? value;
    }
  }
  return value;
}

function splitColorArguments(value: string): string[] {
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function resolveColor(value: string, tokens: Record<string, string>, seen: string[] = []): number[] {
  const variable = /^var\((--[\w-]+)\)$/u.exec(value);
  if (variable) {
    const name = variable[1];
    if (!tokens[name] || seen.includes(name)) throw new Error(`Missing or circular color variable: ${name}`);
    return resolveColor(tokens[name], tokens, [...seen, name]);
  }
  const mixture = /^color-mix\(in srgb,\s*(.+)\)$/u.exec(value);
  if (!mixture) return rgb(value);
  const stops = splitColorArguments(mixture[1]).map(part => {
    const weighted = /^(.*?)\s+(\d+(?:\.\d+)?)%$/u.exec(part);
    return { color: resolveColor(weighted?.[1] ?? part, tokens, seen), weight: weighted ? Number(weighted[2]) / 100 : undefined };
  });
  if (stops.length !== 2) throw new Error(`Expected two color-mix stops: ${value}`);
  const [first, second] = stops;
  const firstWeight = first.weight ?? (second.weight === undefined ? .5 : 1 - second.weight);
  const secondWeight = second.weight ?? 1 - firstWeight;
  if (firstWeight < 0 || secondWeight < 0 || Math.abs(firstWeight + secondWeight - 1) > .000001) {
    throw new Error(`Only opaque, normalized color-mix weights are supported: ${value}`);
  }
  return first.color.map((channel, index) => channel * firstWeight + second.color[index] * secondWeight);
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

it.each(["light", "dark"] as const)("%s 项目列表所有文字在普通、悬停和选中底色达到4.5:1", theme => {
  const sessions = styles("sessions.css");
  const tokens = { ...themeTokens(theme) };
  for (const node of sessions.nodes) {
    if (node.type === "rule" && node.selectors.includes(".session-sidebar")) {
      Object.assign(tokens, Object.fromEntries(Object.entries(declarations(node)).filter(([key]) => key.startsWith("--"))));
    }
  }
  const colors = [
    [".sidebar-heading h2 > span"], [".sidebar-sort-hint"], [".project-toggle"],
    [".search-field"], [".search-field input"], [".search-field input::placeholder"],
    [".search-clear"], [".session-sidebar .machine-filter"], [".sidebar-toolbar .filter-select"],
    [".project-group-name"], [".project-group-path", ".project-toggle"],
    [".project-machine", ".project-toggle"], [".project-machine.offline"],
    [".project-count", ".project-toggle"], [".session-number"],
    [".project-session-choice .session-title", ".session-title"],
    ...["active", "busy", "running", "blocked", "awaiting_input", "error", "idle", "done", "notLoaded", "unknown", "future-status"]
      .map(status => [`.session-compact-status.state-${status}`, ".session-compact-status"]),
  ];
  const backgrounds = [".session-sidebar", ".session-choice:hover", ".session-choice.selected"];
  for (const selectors of colors) {
    const declaration = selectors.map(selector => ruleValue(sessions, selector, "color")).find(value => value !== undefined);
    expect(declaration, `Missing color for ${selectors[0]}`).toBeDefined();
    const foreground = resolveColor(declaration!, tokens);
    for (const selector of backgrounds) {
      const background = ruleValue(sessions, selector, "background");
      expect(background, `Missing background for ${selector}`).toBeDefined();
      expect(contrast(foreground, resolveColor(background!, tokens)), `${selectors[0]} on ${selector}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(ruleValue(sessions, ".project-session-choice .session-title", "opacity")).toBe("1");
});
