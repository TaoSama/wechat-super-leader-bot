import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, validateConsolePublicUrl } from "../../src/runtime/config.js";

describe("Console Public URL & Config Validation", () => {
  const origEnv = process.env;

  afterEach(() => {
    process.env = origEnv;
  });

  it("returns undefined when CONSOLE_PUBLIC_URL is undefined, empty, or whitespace", () => {
    expect(validateConsolePublicUrl(undefined)).toBeUndefined();
    expect(validateConsolePublicUrl("")).toBeUndefined();
    expect(validateConsolePublicUrl("   ")).toBeUndefined();
  });

  it("canonicalizes valid HTTPS origins and loopback HTTP origins", () => {
    expect(validateConsolePublicUrl("https://leader.example.com")).toBe("https://leader.example.com");
    expect(validateConsolePublicUrl("https://leader.example.com/")).toBe("https://leader.example.com");
    expect(validateConsolePublicUrl("https://LEADER.example.com:8443/")).toBe("https://leader.example.com:8443");
    expect(validateConsolePublicUrl("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
    expect(validateConsolePublicUrl("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(validateConsolePublicUrl("http://[::1]:8790")).toBe("http://[::1]:8790");
  });

  it("rejects non-loopback HTTP origins", () => {
    expect(() => validateConsolePublicUrl("http://leader.example.com")).toThrow(/https:/);
    expect(() => validateConsolePublicUrl("http://192.168.1.10:8790")).toThrow(/https:/);
    expect(() => validateConsolePublicUrl("http://10.0.0.1:8790")).toThrow(/https:/);
  });

  it("rejects non-HTTP(S) schemes", () => {
    expect(() => validateConsolePublicUrl("wss://leader.example.com")).toThrow();
    expect(() => validateConsolePublicUrl("ftp://leader.example.com")).toThrow();
    expect(() => validateConsolePublicUrl("javascript:alert(1)")).toThrow();
  });

  it("rejects userinfo, subpaths, query strings, fragments, backslashes, and control characters without leaking raw secrets", () => {
    const rawSecret = "super_secret_credential_99887766";
    const invalidInputs = [
      `https://user:${rawSecret}@leader.example.com`,
      `https://${rawSecret}@leader.example.com`,
      `https://leader.example.com/console/${rawSecret}`,
      `https://leader.example.com?token=${rawSecret}`,
      `https://leader.example.com/?${rawSecret}`,
      `https://leader.example.com#login=${rawSecret}`,
      `https://leader.example.com/#${rawSecret}`,
      `https://leader.example.com\\${rawSecret}`,
      `https://leader.example.com\u0000${rawSecret}`,
      `https://leader.example.com\r\nX-Injected: ${rawSecret}`,
      `https://leader.example.com\u001f${rawSecret}`,
      `https://leader.example.com\u007f${rawSecret}`,
      `not-a-url-${rawSecret}`,
    ];

    for (const input of invalidInputs) {
      try {
        validateConsolePublicUrl(input);
        expect.fail(`Expected validateConsolePublicUrl to throw for input: ${input}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(rawSecret);
      }
    }
  });

  it("loads consolePublicUrl via loadConfig and fails closed on invalid CONSOLE_PUBLIC_URL without leaking raw value", () => {
    process.env = {
      ...origEnv,
      CONTROLLER_TOKEN: "ctrl-token",
      NODE_TOKENS: JSON.stringify({ demoair: "node-tok" }),
      PERSISTENCE_MODE: "memory",
      CONSOLE_PUBLIC_URL: "https://leader.example.com/",
    };

    const cfg = loadConfig();
    expect(cfg.consolePublicUrl).toBe("https://leader.example.com");

    const leakedSecret = "env_secret_value_do_not_echo_12345";
    process.env.CONSOLE_PUBLIC_URL = `https://admin:${leakedSecret}@leader.example.com/subpath?x=1#frag`;
    try {
      loadConfig();
      expect.fail("Expected loadConfig to throw on invalid CONSOLE_PUBLIC_URL");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(leakedSecret);
    }
  });
});
