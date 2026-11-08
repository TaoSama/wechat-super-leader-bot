import { describe, expect, it } from "vitest";
import { loadBackgroundConfig } from "../../src/runtime/background-config.js";

const provider = { model: "test-model", baseUrl: "https://example.test/v1", apiKey: "secret" };
const env = { BACKGROUND_WORKER_ROOT: "/data/workers", BACKGROUND_ARTIFACT_ROOT: "/data/artifacts" };

describe("background execution configuration", () => {
  it("only enables execution with explicit isolated storage and a provider", () => {
    expect(loadBackgroundConfig({}, provider)).toBeUndefined();
    expect(() => loadBackgroundConfig(env)).toThrow(/provider/);
    expect(loadBackgroundConfig(env, provider)).toMatchObject({ ...provider, root: "/data/workers", maxConcurrent: 2 });
  });
  it("rejects shared, nested, relative and root directories", () => {
    for (const artifactRoot of ["/data/workers", "/data/workers/files", "/data", "./files", "/"]) {
      expect(() => loadBackgroundConfig({ ...env, BACKGROUND_ARTIFACT_ROOT: artifactRoot }, provider)).toThrow();
    }
  });
  it("bounds execution budgets and keeps provider override independent from chat", () => {
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_MAX_CONCURRENT: "9" }, provider)).toThrow(/BACKGROUND_MAX_CONCURRENT/);
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_TURN_TIMEOUT_MS: "NaN" }, provider)).toThrow(/BACKGROUND_TURN_TIMEOUT_MS/);
    expect(loadBackgroundConfig({ ...env, BACKGROUND_MODEL_NAME: "background-model" }, provider)?.model).toBe("background-model");
    expect(provider.model).toBe("test-model");
  });
  it("derives isolated worker and artifact directories under the controller data root", () => {
    const configured = loadBackgroundConfig({ BACKGROUND_WORKER_ROOT: "/data/controller-runtime/background/workers" }, provider,
      "/data/controller-runtime");
    expect(configured).toMatchObject({
      root: "/data/controller-runtime/background/workers",
      artifactRoot: "/data/controller-runtime/background/artifacts",
    });
  });
  it("rejects background roots outside the controller data root", () => {
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_WORKER_ROOT: "/data/other/workers" }, provider,
      "/data/controller-runtime")).toThrow(/inside CONTROLLER_DATA_ROOT/);
  });
  it("keeps Codex as the default even with the legacy Claude environment switch", () => {
    expect(loadBackgroundConfig(env, provider)).toMatchObject({ ...provider, executorKind: "codex" });
    expect(loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude" }, provider))
      .toMatchObject({ ...provider, executorKind: "codex" });
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "gemini" }, provider))
      .toThrow(/BACKGROUND_EXECUTOR.*codex, claude/);
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude", BACKGROUND_CLAUDE_API_KEY: "key" }))
      .toThrow(/model provider/);
  });
  it("validates Claude settings only when the task selects that capability", () => {
    const conflicting = loadBackgroundConfig({ ...env, BACKGROUND_CLAUDE_API_KEY: "a", BACKGROUND_CLAUDE_OAUTH_TOKEN: "b" }, provider)!;
    expect(conflicting.model).toBe(provider.model);
    expect(() => conflicting.resolveClaude!()).toThrow(/only one/);
    const claude = loadBackgroundConfig({ ...env, BACKGROUND_CLAUDE_OAUTH_TOKEN: " token ", BACKGROUND_CLAUDE_MODEL: "opus" }, provider)!;
    expect(claude.resolveClaude!()).toMatchObject({ path: "claude", model: "opus", oauthToken: "token" });
    expect(claude.resolveClaude!().apiKey).toBeUndefined();
    const fallback = loadBackgroundConfig({ ...env, BACKGROUND_CLAUDE_API_KEY: "key", BACKGROUND_CLAUDE_PATH: "/opt/claude" }, provider)!;
    expect(fallback.resolveClaude!()).toMatchObject({ path: "/opt/claude", apiKey: "key" });
    expect(fallback.resolveClaude!().model).toBeUndefined();
  });
  it("rejects a non-Claude model lazily and keeps controller state private to its sandbox", () => {
    const claudeEnv = { ...env, BACKGROUND_CLAUDE_API_KEY: "key" };
    for (const model of ["gpt-5.5", "claude-cli-default", "sonnet; rm"]) {
      const config = loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_MODEL: model }, provider)!;
      expect(() => config.resolveClaude!()).toThrow(/BACKGROUND_CLAUDE_MODEL/);
    }
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_MODEL: "claude-sonnet-4-5" }, provider)!.resolveClaude!().model)
      .toBe("claude-sonnet-4-5");
    expect(loadBackgroundConfig(claudeEnv, provider)!.resolveClaude!().privateRoots).toEqual(["/data/workers"]);
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_WORKER_ROOT: "/data/runtime/background/workers", BACKGROUND_ARTIFACT_ROOT: "" },
      provider, "/data/runtime")!.resolveClaude!().privateRoots).toEqual(["/data/runtime"]);
  });
  it("reuses the background gateway for Claude only when no Claude credential is set", () => {
    const resolve = (overrides: NodeJS.ProcessEnv = {}) => loadBackgroundConfig({ ...env, ...overrides }, provider)!.resolveClaude!();
    expect(resolve({ BACKGROUND_MODEL_BASE_URL: "https://gateway.test/v1/", BACKGROUND_MODEL_API_KEY: "gw" }))
      .toMatchObject({ baseUrl: "https://gateway.test", apiKey: "gw" });
    expect(loadBackgroundConfig({ ...env, BACKGROUND_MODEL_NAME: "summary", BACKGROUND_MODEL_BASE_URL: "https://gateway.test/v1",
      BACKGROUND_MODEL_API_KEY: "gw" }, provider)?.summaryProvider).toEqual({ model: "summary", baseUrl: "https://gateway.test/v1", apiKey: "gw" });
    expect(resolve()).toMatchObject({ baseUrl: "https://example.test", apiKey: "secret" });
    const official = resolve({ BACKGROUND_CLAUDE_API_KEY: "official" });
    expect(official).toMatchObject({ apiKey: "official" });
    expect(official.baseUrl).toBeUndefined();
    expect(resolve({ BACKGROUND_CLAUDE_AUTH_TOKEN: "bearer", BACKGROUND_CLAUDE_BASE_URL: "https://gateway.test/anthropic/v1" }))
      .toMatchObject({ baseUrl: "https://gateway.test/anthropic", authToken: "bearer" });
    for (const url of ["ftp://gateway.test", "https://user:pass@gateway.test", "https://gateway.test/?key=1", "not a url"]) {
      expect(() => resolve({ BACKGROUND_CLAUDE_BASE_URL: url })).toThrow(/BACKGROUND_CLAUDE_BASE_URL/);
    }
    expect(() => resolve({ BACKGROUND_CLAUDE_API_KEY: "a", BACKGROUND_CLAUDE_AUTH_TOKEN: "b" })).toThrow(/only one/);
    expect(resolve({ BACKGROUND_CLAUDE_MODEL: "anthropic/claude-sonnet-4.5" }).model).toBe("anthropic/claude-sonnet-4.5");
  });
  it("freezes Claude capability settings when loading the runtime configuration", () => {
    const source = { ...env, BACKGROUND_CLAUDE_MODEL: "opus" };
    const config = loadBackgroundConfig(source, provider)!;
    source.BACKGROUND_CLAUDE_MODEL = "haiku";
    expect(config.resolveClaude!().model).toBe("opus");
  });
});
