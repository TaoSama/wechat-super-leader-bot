import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSettings } from "../../src/features/settings/ModelSettings";
const scope = { id: "wechat", label: "微信助手", model: "a", reasoningEffort: null, revision: "v1", editable: true, effect: "下一轮", provider: "provider" } as const;
const catalog = { scope: "wechat", models: [{ id: "a", label: "A", reasoningEfforts: ["low"] }, { id: "b", label: "B", reasoningEfforts: ["medium"] }], fetchedAt: "2026-10-23T08:00:00Z", source: "runtime", version: "1.0.0", stale: false };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());
it("模型冲突后显式读取最新修订，保留选择且不自动重发", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("models?")) return response(catalog);
    if (url === "/v1/settings") return response({ scopes: [{ ...scope, revision: "v2", reasoningEffort: "low" }], chats: [], diagnostics: [] });
    if (url === "/v1/settings/models") {
      const body = JSON.parse(String(init?.body)); writes.push(body);
      return writes.length === 1 ? response({}, 409) : response({ ...scope, ...body, id: "wechat", revision: "v3" });
    }
    return response({}, 404);
  }));
  render(<ModelSettings scope={scope} onAuthFailure={vi.fn()} />);
  fireEvent.click(await screen.findByRole("combobox", { name: "微信助手模型" }, { timeout: 10000 }));
  fireEvent.click(screen.getByRole("option", { name: "B" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(await screen.findByRole("button", { name: "读取最新设置" }, { timeout: 10000 }));
  await screen.findByText(/服务器当前：a \/ low/);
  expect(screen.getByRole("combobox", { name: "微信助手模型" })).toHaveTextContent("B");
  expect(writes).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存，下一轮");
  expect(writes[1]).toEqual({ scope: "wechat", model: "b", reasoningEffort: null, expectedRevision: "v2" });
}, 30000);
it("干净的模型表单接纳外部新设置，编辑中的选择保留", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(catalog)));
  const onAuthFailure = vi.fn();
  const { rerender } = render(<ModelSettings scope={scope} onAuthFailure={onAuthFailure} />);
  await screen.findByRole("combobox", { name: "微信助手模型" }, { timeout: 10000 });
  rerender(<ModelSettings scope={{ ...scope, model: "b", reasoningEffort: "medium", revision: "v2" }} onAuthFailure={onAuthFailure} />);
  expect(screen.getByRole("combobox", { name: "微信助手模型" })).toHaveTextContent("B");
  fireEvent.click(screen.getByRole("combobox", { name: "微信助手模型" }));
  fireEvent.click(screen.getByRole("option", { name: "A" }));
  rerender(<ModelSettings scope={{ ...scope, model: "b", reasoningEffort: "medium", revision: "v3" }} onAuthFailure={onAuthFailure} />);
  expect(screen.getByRole("combobox", { name: "微信助手模型" })).toHaveTextContent("A");
  expect(screen.getByRole("button", { name: "读取最新设置" })).toBeInTheDocument();
}, 30000);
it("不可编辑的模型作用域不读取或刷新目录", async () => {
  const fetchImpl = vi.fn(async () => response(catalog));
  vi.stubGlobal("fetch", fetchImpl);
  render(<ModelSettings scope={{ ...scope, editable: false }} onAuthFailure={vi.fn()} />);
  expect(await screen.findByText("当前执行环境仅支持查看。")).toBeInTheDocument();
  const refresh = screen.getByRole("button", { name: "刷新目录" });
  expect(refresh).toBeDisabled();
  fireEvent.click(refresh);
  expect(fetchImpl).not.toHaveBeenCalled();
});
