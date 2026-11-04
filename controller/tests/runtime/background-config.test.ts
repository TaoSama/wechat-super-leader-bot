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
    expect(() => loadBackgroundConfig({ ...env, BACKGROUND_EXECUTOR: "claude" }, provider))
      .toThrow(/BACKGROUND_CLAUDE_API_KEY or BACKGROUND_CLAUDE_OAUTH_TOKEN/);
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
});
