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
  it("defaults to Codex and validates the opt-in Claude executor", () => {
    expect(loadBackgroundConfig(env, provider)).toMatchObject({ executorKind: "codex" });
    expect(loadBackgroundConfig(env, provider)?.claude).toBeUndefined();
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "gemini" }, provider)).toThrow(/BACKGROUND_EXECUTOR.*codex, claude/);
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude" }))
      .toThrow(/BACKGROUND_CLAUDE_API_KEY, BACKGROUND_CLAUDE_AUTH_TOKEN, BACKGROUND_CLAUDE_OAUTH_TOKEN/);
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude", BACKGROUND_CLAUDE_API_KEY: "a",
      BACKGROUND_CLAUDE_OAUTH_TOKEN: "b" }, provider)).toThrow(/only one/);
    const claude = loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude", BACKGROUND_CLAUDE_OAUTH_TOKEN: " token ",
      BACKGROUND_CLAUDE_MODEL: "opus" });
    expect(claude).toMatchObject({ executorKind: "claude", model: "opus", baseUrl: "", apiKey: "",
      claude: { path: "claude", model: "opus", oauthToken: "token" } });
    expect(claude?.claude?.apiKey).toBeUndefined();
    const fallback = loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude", BACKGROUND_CLAUDE_API_KEY: "key",
      BACKGROUND_CLAUDE_PATH: "/opt/claude" }, provider);
    expect(fallback).toMatchObject({ model: "claude-cli-default", apiKey: "", claude: { path: "/opt/claude", apiKey: "key" } });
    expect(fallback?.claude?.model).toBeUndefined();
  });
  it("rejects a non-Claude model and keeps controller state private to the Claude sandbox", () => {
    const claudeEnv = { ...env, BACKGROUND_EXECUTOR: "claude", BACKGROUND_CLAUDE_API_KEY: "key" };
    for (const model of ["gpt-5.5", "claude-cli-default", "sonnet; rm"]) {
      expect(() => loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_MODEL: model })).toThrow(/BACKGROUND_CLAUDE_MODEL/);
    }
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_MODEL: "claude-sonnet-4-5" })?.claude?.model).toBe("claude-sonnet-4-5");
    expect(loadBackgroundConfig(claudeEnv)?.claude?.privateRoots).toEqual(["/data/workers"]);
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_WORKER_ROOT: "/data/runtime/background/workers", BACKGROUND_ARTIFACT_ROOT: "" },
      undefined, "/data/runtime")?.claude?.privateRoots).toEqual(["/data/runtime"]);
  });
  it("reuses the background gateway for Claude only when no Claude credential is set", () => {
    const claudeEnv = { ...env, BACKGROUND_EXECUTOR: "claude" };
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_MODEL_BASE_URL: "https://gateway.test/v1/", BACKGROUND_MODEL_API_KEY: "gw" })?.claude)
      .toMatchObject({ baseUrl: "https://gateway.test", apiKey: "gw" });
    // Falls back to the leader provider, like the Codex background provider does.
    expect(loadBackgroundConfig(claudeEnv, provider)?.claude).toMatchObject({ baseUrl: "https://example.test", apiKey: "secret" });
    // A Claude-specific credential never travels to the inherited gateway URL.
    const official = loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_API_KEY: "official" }, provider)?.claude;
    expect(official).toMatchObject({ apiKey: "official" });
    expect(official?.baseUrl).toBeUndefined();
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_AUTH_TOKEN: "bearer",
      BACKGROUND_CLAUDE_BASE_URL: "https://gateway.test/anthropic/v1" }, provider)?.claude)
      .toMatchObject({ baseUrl: "https://gateway.test/anthropic", authToken: "bearer" });
    for (const url of ["ftp://gateway.test", "https://user:pass@gateway.test", "https://gateway.test/?key=1", "not a url"]) {
      expect(() => loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_BASE_URL: url }, provider)).toThrow(/BACKGROUND_CLAUDE_BASE_URL/);
    }
    expect(() => loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_API_KEY: "a", BACKGROUND_CLAUDE_AUTH_TOKEN: "b" }, provider))
      .toThrow(/only one/);
    expect(loadBackgroundConfig({ ...claudeEnv, BACKGROUND_CLAUDE_MODEL: "anthropic/claude-sonnet-4.5" }, provider)?.claude?.model)
      .toBe("anthropic/claude-sonnet-4.5");
  });
});
