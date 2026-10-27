import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { disabledWorkspaceSkills, RuntimeResources } from "../../src/settings/resources.js";

function binary(): string | undefined {
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  const platform = { darwin: "apple-darwin", linux: "unknown-linux-musl", win32: "pc-windows-msvc" }[process.platform as "darwin"];
  if (!architecture || !platform) return undefined;
  const sdk = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const codex = createRequire(sdk.resolve("@openai/codex/package.json"));
  const root = path.dirname(codex.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`));
  for (const directory of ["bin", "codex"]) {
    const candidate = path.join(root, "vendor", `${architecture}-${platform}`, directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

class NativeProbe {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private readonly exited: Promise<unknown>;
  constructor(private child: ChildProcessWithoutNullStreams) {
    this.exited = once(child, "exit");
    let buffer = "";
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const waiter = this.pending.get(frame.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(frame.id);
          if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)));
          else waiter.resolve(frame.result);
        }
      }
    });
    child.once("exit", () => {
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Native probe exited")); }
      this.pending.clear();
    });
  }
  rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Native probe timed out: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  notify(method: string): void { this.child.stdin.write(JSON.stringify({ method, params: {} }) + "\n"); }
  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

test("locked native CLI discovers edited frozen skills, disables original paths, and reads snapshot child files without auth", {
  timeout: 30_000,
  skip: process.env.SUPER_LEADER_SKIP_NATIVE_SKILL_DISCOVERY === "1"
    ? "Ubuntu unit jobs run without the AppArmor sandbox setup"
    : false,
}, async t => {
  const executable = binary();
  if (!executable) { t.skip("Native Codex binary unavailable on this platform"); return; }
  assert.match(execFileSync(executable, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH } }), /^codex-cli 0\.163\.0\s/);
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "settings-skill-discovery-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const chat = path.join(temporary, "chat");
  const home = path.join(temporary, "frozen-home");
  const codexHome = path.join(chat, ".codex");
  // The fixture uses a disposable legacy user root instead of mutating /etc/codex/skills.
  const deployed = path.join(codexHome, "skills");
  const bundle = path.join(deployed, "probe");
  fs.mkdirSync(path.join(bundle, "scripts"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(bundle, "SKILL.md"), "---\nname: original-admin-probe\ndescription: Original administrator skill\n---\nRead scripts/child.txt\n");
  fs.writeFileSync(path.join(bundle, "scripts", "child.txt"), "original child content");
  const resources = new RuntimeResources({ root: path.join(temporary, "resources"), skillsRoot: deployed, defaults: {} });
  for (const [id, content] of [
    ["skill/probe/SKILL.md", "---\nname: frozen-settings-probe\ndescription: Edited frozen skill\n---\nRead scripts/child.txt\n"],
    ["skill/probe/scripts/child.txt", "edited frozen child content"],
  ]) resources.write(id, { content, expectedRevision: resources.read(id).revision });
  resources.snapshotSkills(path.join(home, ".agents", "skills"));
  const original = path.join(bundle, "SKILL.md");
  const localSkill = path.join(chat, ".agents", "skills", "local-probe", "SKILL.md");
  fs.mkdirSync(path.dirname(localSkill), { recursive: true });
  fs.writeFileSync(localSkill, "---\nname: local-workspace-probe\ndescription: Workspace local probe\n---\nExisting local skill\n");
  const runtimeRoot = path.dirname(path.dirname(path.dirname(path.dirname(executable))));
  const permissions = `permissions.probe={filesystem={":minimal"="read",${JSON.stringify(runtimeRoot)}="read",${JSON.stringify(home)}="read",${JSON.stringify(chat)}="write",${JSON.stringify(path.join(chat, ".agents"))}="deny",${JSON.stringify(codexHome)}="deny"},network={enabled=false}}`;
  const launch = async (disabled: string[]) => {
    const config = `[${disabled.map(file => `{path=${JSON.stringify(file)},enabled=false}`).join(",")}]`;
    const probe = new NativeProbe(spawn(executable, ["app-server", "-c", "skills.bundled.enabled=false", "-c", "default_permissions=\"probe\"", "-c", permissions,
      "-c", `skills.config=${config}`], {
      cwd: chat, env: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"],
    }));
    try {
      await probe.rpc("initialize", { clientInfo: { name: "settings_native_probe", version: "1.0" }, capabilities: { experimentalApi: true } });
      probe.notify("initialized");
      return probe;
    } catch (error) { await probe.close(); throw error; }
  };
  const list = async (probe: NativeProbe) => {
    const result = await probe.rpc("skills/list", { cwds: [chat], forceReload: true });
    return result.data.flatMap((entry: any) => entry.skills);
  };
  const baseline = await launch([]);
  try {
    const skills = await list(baseline);
    assert.equal(skills.find((skill: any) => skill.path === original)?.enabled, true);
    assert.equal(skills.find((skill: any) => skill.path === localSkill)?.enabled, true,
      "filesystem deny does not hide workspace skill metadata from discovery");
  } finally { await baseline.close(); }
  const directoryDisabled = await launch([bundle]);
  try {
    const skills = await list(directoryDisabled);
    assert.equal(skills.find((skill: any) => skill.path === original)?.enabled, true,
      "directory disable does not disable SKILL.md; configuration must use the file path");
  } finally { await directoryDisabled.close(); }
  const probe = await launch([original, ...disabledWorkspaceSkills(chat).map(skill => skill.path)]);
  try {
    const skills = await list(probe);
    const frozen = skills.find((skill: any) => skill.name === "frozen-settings-probe");
    assert.equal(frozen?.path, path.join(home, ".agents", "skills", "probe", "SKILL.md"));
    assert.equal(frozen?.enabled, true);
    const originals = skills.filter((skill: any) => skill.path === original);
    assert.equal(originals.length, 1);
    assert.equal(originals[0].enabled, false, "SKILL.md file path disables the source skill");
    assert.equal(skills.find((skill: any) => skill.path === localSkill)?.enabled, false);
    assert.equal(skills.filter((skill: any) => skill.enabled).length, 1);
    const command = await probe.rpc("command/exec", { command: ["/bin/cat", path.join(path.dirname(frozen.path), "scripts", "child.txt")], cwd: chat, timeoutMs: 5000 });
    assert.equal(command.exitCode, 0, command.stderr);
    assert.equal(command.stdout, "edited frozen child content");
    t.diagnostic(`native ${execFileSync(executable, ["--version"], { encoding: "utf8" }).trim()}; frozen user skill enabled; original SKILL.md disabled; child content from snapshot`);
  } finally { await probe.close(); }
});
