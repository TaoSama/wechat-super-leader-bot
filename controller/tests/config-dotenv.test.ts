import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FILE_TOKEN = "synthetic-file-controller-token";
const FILE_API_KEY = "synthetic-file-model-api-key";
const originalEnv = process.env;
const originalCwd = process.cwd();
let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "controller-dotenv-test-"));
  writeFileSync(join(fixtureDir, ".env"), [
    `CONTROLLER_TOKEN=${FILE_TOKEN}`,
    "NODE_TOKENS={\"fixture\":\"synthetic-file-node-token\"}",
    "PERSISTENCE_MODE=memory",
    "LEADER_MODE=model",
    "LEADER_MODEL_BASE_URL=https://synthetic.invalid/v1",
    "LEADER_MODEL_NAME=synthetic-file-model",
    `LEADER_MODEL_API_KEY=${FILE_API_KEY}`,
  ].join("\n"));
  process.chdir(fixtureDir);
  process.env = { SUPER_LEADER_NO_DOTENV: "1" };
  vi.resetModules();
});

afterEach(() => {
  process.env = originalEnv;
  process.chdir(originalCwd);
  vi.resetModules();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("explicit dotenv isolation", () => {
  it("does not import file credentials and still requires authentication", async () => {
    const { loadConfig } = await import("../src/config.js");
    expect(process.env.CONTROLLER_TOKEN).toBeUndefined();
    expect(process.env.LEADER_MODEL_API_KEY).toBeUndefined();
    expect(process.env.NODE_TOKENS).toBeUndefined();
    expect(() => loadConfig()).toThrow(/CONTROLLER_TOKEN.*required/);
  });

  it("uses only explicit environment and keeps database and model validation fail-closed", async () => {
    process.env.CONTROLLER_TOKEN = "synthetic-explicit-token";
    const { loadConfig } = await import("../src/config.js");
    expect(() => loadConfig()).toThrow(/DATABASE_URL.*required/);
    process.env.PERSISTENCE_MODE = "memory";
    const config = loadConfig();
    expect(config.controllerToken).toBe("synthetic-explicit-token");
    expect(config.nodeTokens).toEqual({});
    expect(config.leader).toBeUndefined();
    process.env.LEADER_MODE = "model";
    expect(() => loadConfig()).toThrow(/Model mode requires/);
    expect(process.env.LEADER_MODEL_API_KEY).toBeUndefined();
  });

  it.each([undefined, "0", "true"])("preserves default dotenv loading when the switch is %s", async (value) => {
    if (value === undefined) delete process.env.SUPER_LEADER_NO_DOTENV;
    else process.env.SUPER_LEADER_NO_DOTENV = value;
    const { loadConfig } = await import("../src/config.js");
    const config = loadConfig();
    expect(config.controllerToken).toBe(FILE_TOKEN);
    expect(config.nodeTokens).toEqual({ fixture: "synthetic-file-node-token" });
    expect(config.leader?.apiKey).toBe(FILE_API_KEY);
  });
});
