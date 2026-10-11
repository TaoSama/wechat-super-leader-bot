import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { PostMessageRequestSchema } from "../src/types.js";

beforeEach(() => {
  vi.stubEnv("CONTROLLER_TOKEN", "test-controller");
  vi.stubEnv("PERSISTENCE_MODE", "memory");
  vi.stubEnv("NODE_TOKENS", "{}");
  vi.stubEnv("LEADER_MODE", "rules");
  vi.stubEnv("LEADER_MODEL_BASE_URL", "");
  vi.stubEnv("LEADER_MODEL_NAME", "");
  vi.stubEnv("LEADER_MODEL_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

it("does not silently enable model requests without an explicit mode", () => {
  expect(loadConfig().leader).toBeUndefined();
  vi.stubEnv("LEADER_MODE", "unknown");
  expect(() => loadConfig()).toThrow("LEADER_MODE");
});

it("requires all model fields and never includes secret values in a configuration error", () => {
  vi.stubEnv("LEADER_MODE", "model");
  vi.stubEnv("LEADER_MODEL_API_KEY", "secret-fixture-key");
  expect(() => loadConfig()).toThrow("requires");
  try { loadConfig(); } catch (error) { expect(String(error)).not.toContain("secret-fixture-key"); }
  vi.stubEnv("LEADER_MODEL_BASE_URL", "https://model.example/v1");
  vi.stubEnv("LEADER_MODEL_NAME", "tool-model");
  expect(loadConfig().leader?.model).toBe("tool-model");
});

it("bounds channel identifiers and message text before any model request", () => {
  expect(PostMessageRequestSchema.safeParse({ chatId: "c".repeat(65), messageId: "m", text: "test" }).success).toBe(false);
  expect(PostMessageRequestSchema.safeParse({ chatId: "c", messageId: "m", text: "x".repeat(16001) }).success).toBe(false);
});
