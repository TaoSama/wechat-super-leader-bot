import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("Config Validation", () => {
  const origEnv = process.env;

  it("strictly validates numerical port and TTL values", () => {
    process.env = {
      ...origEnv,
      CONTROLLER_TOKEN: "ctrl-token",
      NODE_TOKENS: JSON.stringify({ demoair: "node-tok" }),
      PERSISTENCE_MODE: "memory",
      PORT: "not-a-number",
    };
    expect(() => loadConfig()).toThrow(/Invalid PORT/);

    process.env.PORT = "8790";
    process.env.COMMAND_TTL_SECONDS = "abc";
    expect(() => loadConfig()).toThrow(/Invalid COMMAND_TTL_SECONDS/);

    process.env.COMMAND_TTL_SECONDS = "-1";
    expect(() => loadConfig()).toThrow(/Invalid COMMAND_TTL_SECONDS/);

    process.env.COMMAND_TTL_SECONDS = "100000";
    expect(() => loadConfig()).toThrow(/Invalid COMMAND_TTL_SECONDS/);

    process.env.COMMAND_TTL_SECONDS = "300";
    const cfg = loadConfig();
    expect(cfg.port).toBe(8790);
    expect(cfg.commandTtlSeconds).toBe(300);

    process.env = origEnv;
  });

  it("redacts raw token values on JSON parse error", () => {
    process.env = {
      ...origEnv,
      CONTROLLER_TOKEN: "ctrl-token",
      NODE_TOKENS: "super-secret-raw-token-not-json",
      PERSISTENCE_MODE: "memory",
    };
    try {
      loadConfig();
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("NODE_TOKENS is not valid JSON");
      expect(err.message).not.toContain("super-secret-raw-token-not-json");
    }
    process.env = origEnv;
  });
});
