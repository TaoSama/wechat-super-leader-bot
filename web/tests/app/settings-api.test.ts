import { afterEach, expect, it, vi } from "vitest";
import { ApiAuthError, ApiHttpError } from "../../src/api/errors";
import { loadResources, saveResource } from "../../src/api/settings";
const resource = { id: "gateway.tool", kind: "tool", title: "工具", scope: "instance", path: "tools/read.json", revision: "r1", version: "1.0.0", editable: true, effect: "下一轮", content: "{}", language: "json" } as const;
afterEach(() => vi.unstubAllGlobals());
it("403资源写入拒绝保留登录，401才作为认证失效", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
  await expect(saveResource(resource, "{}" )).rejects.toBeInstanceOf(ApiHttpError);
  await expect(saveResource(resource, "{}" )).rejects.not.toBeInstanceOf(ApiAuthError);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  await expect(loadResources()).rejects.toBeInstanceOf(ApiAuthError);
});
it("409明确保留草稿且不自动重发", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  await expect(saveResource(resource, "new" )).rejects.toThrow("草稿已保留");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("资源列表保留上游不可用诊断，不伪装为完整目录", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ resources: [], diagnostics: [{ id: "gateway-settings", label: "微信助手设置", value: "连接不可用", status: "error" }] }))));
  const index = await loadResources("chat-a");
  expect(index.resources).toEqual([]);
  expect(index.diagnostics[0].value).toBe("连接不可用");
});
