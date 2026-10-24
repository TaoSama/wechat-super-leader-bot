import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { loadConfig } from "../../src/runtime/config.js";

describe("Config Validation", () => {
  const origEnv = process.env;

  afterEach(() => {
    process.env = origEnv;
  });

  it("strictly validates numerical port and TTL values", () => {
    process.env = {
      ...origEnv,
      CONTROLLER_TOKEN: "ctrl-token",
      NODE_TOKENS: JSON.stringify({ macair: "node-tok" }),
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

  describe("token whitespace and control characters", () => {
    beforeEach(() => {
      process.env = {
        SUPER_LEADER_NO_DOTENV: "1",
        CONTROLLER_TOKEN: "controller-secret",
        NODE_TOKENS: JSON.stringify({ macair: "node-secret" }),
        PERSISTENCE_MODE: "memory",
      };
    });

    const invalidTokens = [
      ["leading space", " secret-token"],
      ["trailing space", "secret-token "],
      ["leading tab", "\tsecret-token"],
      ["trailing newline", "secret-token\n"],
      ["trailing carriage return", "secret-token\r"],
      ["leading Unicode whitespace", "\u00a0secret-token"],
      ["trailing Unicode whitespace", "secret-token\u2003"],
      ["embedded NUL", "secret\u0000token"],
      ["embedded tab", "secret\ttoken"],
      ["embedded newline", "secret\ntoken"],
      ["embedded DEL", "secret\u007ftoken"],
    ];

    it.each(invalidTokens)("rejects controller tokens with %s without exposing the credential", (_label, token) => {
      process.env.CONTROLLER_TOKEN = token;
      expect(() => loadConfig()).toThrowError(
        new Error("CONTROLLER_TOKEN must not contain leading/trailing whitespace or control characters"),
      );
    });

    it.each(invalidTokens)("rejects node tokens with %s without exposing the credential", (_label, token) => {
      process.env.NODE_TOKENS = JSON.stringify({ macair: token });
      expect(() => loadConfig()).toThrowError(
        new Error("NODE_TOKENS must not contain leading/trailing whitespace or control characters"),
      );
    });

    it("preserves supported token characters and exact node-token mappings", () => {
      const controllerToken = "controller:secret!@#$%^&*()[]{}=+/.~_-";
      const nodeToken = "node:secret!@#$%^&*()[]{}=+/.~_-";
      process.env.CONTROLLER_TOKEN = controllerToken;
      process.env.NODE_TOKENS = JSON.stringify({ macair: nodeToken });

      const config = loadConfig();
      expect(config.controllerToken).toBe(controllerToken);
      expect(config.nodeTokens.macair).toBe(nodeToken);
      expect(config.tokenToNode.get(nodeToken)).toBe("macair");
      expect(config.tokenToNode.get(`${nodeToken} `)).toBeUndefined();
    });

    it("continues to reject duplicate node credentials", () => {
      process.env.NODE_TOKENS = JSON.stringify({ macair: "same-secret", macmini: "same-secret" });
      expect(() => loadConfig()).toThrowError(
        "NODE_TOKENS contains duplicate token for nodes 'macair' and 'macmini' (mapping ambiguity)",
      );
    });

    it("continues to reject empty controller and node credentials", () => {
      process.env.CONTROLLER_TOKEN = " ";
      expect(() => loadConfig()).toThrowError("CONTROLLER_TOKEN environment variable is required and cannot be empty");
      process.env.CONTROLLER_TOKEN = "controller-secret";
      process.env.NODE_TOKENS = JSON.stringify({ macair: " " });
      expect(() => loadConfig()).toThrowError("NODE_TOKENS token for node 'macair' must be a non-empty string");
    });
  });
});
