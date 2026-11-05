import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyClaudeSandbox } from "../../../src/background/worker/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const READY = { enabled: true, strictMode: true, unavailableReason: null };

/** A fake CLI that records its arguments and prints the given `claude sandbox status` posture. */
function fakeClaude(status: unknown, exitCode = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sandbox-check-test-")); roots.push(root);
  const script = path.join(root, "claude"), observed = path.join(root, "observed.json");
  fs.writeFileSync(script, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR, apiKey: process.env.ANTHROPIC_API_KEY }));
console.log(${JSON.stringify(typeof status === "string" ? status : JSON.stringify(status))});
process.exit(${exitCode});
`, { mode: 0o700 });
  const options = { claudePath: script, artifactRoot: path.join(root, "artifacts"), privateRoots: [path.join(root, "data")], platform: "darwin" as const };
  return { options, observed: () => JSON.parse(fs.readFileSync(observed, "utf8")) };
}

describe("Claude sandbox startup check", () => {
  it("passes when the worker settings load with a strict sandbox", async () => {
    const f = fakeClaude(READY);
    await expect(verifyClaudeSandbox(f.options)).resolves.toBeUndefined();
    const seen = f.observed();
    expect(seen.args.slice(-2)).toEqual(["sandbox", "status"]);
    expect(seen.args[seen.args.indexOf("--setting-sources") + 1]).toBe("user");
    const settings = JSON.parse(seen.args[seen.args.indexOf("--settings") + 1]);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      filesystem: { denyRead: [f.options.artifactRoot, ...f.options.privateRoots, path.join(os.tmpdir(), "*")] } });
    expect(seen.apiKey).toBeUndefined();
    // The scratch config directory does not outlive the check.
    expect(fs.existsSync(seen.configDir)).toBe(false);
  });
  it.each([
    ["missing dependencies", { ...READY, enabled: false, unavailableReason: "bubblewrap (bwrap) not installed" }, /bubblewrap \(bwrap\) not installed/],
    ["skipped settings", { ...READY, enabled: false, strictMode: false }, /worker settings were not applied/],
    ["unsandboxed fallback", { ...READY, strictMode: false }, /unsandboxed commands are not disabled/],
    ["no posture", "not json", /no posture/],
  ])("refuses the Claude executor on %s", async (_name, status, reason) => {
    await expect(verifyClaudeSandbox(fakeClaude(status).options)).rejects.toThrow(reason);
    await expect(verifyClaudeSandbox(fakeClaude(status).options)).rejects.toThrow(/never run unsandboxed/);
  });
  it("refuses when the CLI fails or is missing", async () => {
    await expect(verifyClaudeSandbox(fakeClaude(READY, 1).options)).rejects.toThrow(/sandbox status failed/);
    await expect(verifyClaudeSandbox({ ...fakeClaude(READY).options, claudePath: "/nonexistent/claude" })).rejects.toThrow(/Claude executable is unavailable/);
  });
  it("requires a working bubblewrap on Linux", async () => {
    const f = fakeClaude(READY);
    const savedPath = process.env.PATH;
    process.env.PATH = path.dirname(f.options.claudePath);
    try {
      await expect(verifyClaudeSandbox({ ...f.options, platform: "linux", managedSettingsPath: path.join(path.dirname(f.options.claudePath), "absent.json") }))
        .rejects.toThrow(/bubblewrap is not installed/);
    } finally { process.env.PATH = savedPath; }
  });
  it("trials the bubblewrap that managed settings point Claude Code at, off PATH", async () => {
    const f = fakeClaude(READY);
    const root = path.dirname(f.options.claudePath);
    const bwrap = path.join(root, "bwrap-off-path"), trial = path.join(root, "trial.json"), managed = path.join(root, "managed-settings.json");
    fs.writeFileSync(bwrap, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(trial)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
    fs.writeFileSync(managed, JSON.stringify({ sandbox: { bwrapPath: bwrap } }));
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(root, "empty");
    try {
      await expect(verifyClaudeSandbox({ ...f.options, platform: "linux", managedSettingsPath: managed })).resolves.toBeUndefined();
      expect(JSON.parse(fs.readFileSync(trial, "utf8"))).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid", "--proc"]));
      fs.writeFileSync(managed, JSON.stringify({ sandbox: { bwrapPath: path.join(root, "missing-bwrap") } }));
      await expect(verifyClaudeSandbox({ ...f.options, platform: "linux", managedSettingsPath: managed })).rejects.toThrow(/bubblewrap is not installed/);
      fs.writeFileSync(managed, "{not json");
      await expect(verifyClaudeSandbox({ ...f.options, platform: "linux", managedSettingsPath: managed })).rejects.toThrow(/managed settings are unreadable/);
    } finally { process.env.PATH = savedPath; }
  });
});
