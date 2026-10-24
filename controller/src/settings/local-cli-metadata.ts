import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalModelCatalog } from "./local-contracts.js";

const METADATA_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 2048;
const CACHE_MS = 5 * 60_000;
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;
type Metadata = { version?: string; models: LocalModelCatalog["models"] };

function command(executable: string, args: string[], home: string, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home };
    for (const name of ENV_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(executable, args, { env, cwd: home, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let failed = false, bytes = 0;
    const chunks: Buffer[] = [];
    const kill = () => {
      failed = true;
      if (!child.pid) return;
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.warn("Catalog CLI cleanup could not be confirmed"); }
    };
    const timer = setTimeout(kill, Math.max(1, deadline - Date.now()));
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) kill(); else chunks.push(chunk); });
    child.stderr.on("data", () => { /* Drain private diagnostics without retaining or exposing them. */ });
    child.once("error", () => { failed = true; });
    child.once("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("Optional catalog metadata unavailable"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export class LocalCliMetadata {
  private pending?: Promise<Metadata>;
  private cached?: { at: number; value: Metadata };
  constructor(private readonly executable = "codex") {}
  read(deadline: number): Promise<Metadata> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return Promise.resolve(structuredClone(this.cached.value));
    if (!this.pending) {
      this.pending = this.load(Math.min(deadline, Date.now() + METADATA_TIMEOUT_MS)).then(value => {
        this.cached = { at: Date.now(), value }; return value;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }
  private async load(deadline: number): Promise<Metadata> {
    const home = await mkdtemp(path.join(os.tmpdir(), "controller-model-metadata-"));
    let version: string | undefined;
    try {
      const rawVersion = (await command(this.executable, ["--version"], home, deadline)).trim();
      if (/^codex(?:-cli)? \d+\.\d+\.\d+[^\r\n]{0,100}$/.test(rawVersion)) version = rawVersion;
      const raw = JSON.parse(await command(this.executable, ["debug", "models", "--bundled"], home, deadline)) as { models?: unknown };
      if (!Array.isArray(raw.models) || raw.models.length > MAX_MODELS) throw new Error("Invalid bundled metadata");
      const models: Metadata["models"] = [];
      for (const value of raw.models) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>, id = item.slug ?? item.id;
        if (typeof id !== "string" || id.length > 200 || !id) continue;
        const values = item.supported_reasoning_levels;
        const efforts = Array.isArray(values) ? values.flatMap(value => {
          const effort = value && typeof value === "object" && "effort" in value ? value.effort : undefined;
          return typeof effort === "string" && /^[a-z_]{1,32}$/.test(effort) ? [effort] : [];
        }) : [];
        const defaultEffort = item.default_reasoning_level;
        models.push({ id, label: typeof item.display_name === "string" ? item.display_name : id,
          reasoningEfforts: [...new Set(efforts)], metadataSource: "cli-bundled",
          ...(typeof defaultEffort === "string" && efforts.includes(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {}),
          ...(typeof item.context_window === "number" && Number.isSafeInteger(item.context_window) && item.context_window > 0 ? { contextWindow: item.context_window } : {}) });
      }
      return { version, models };
    } catch {
      // Optional offline metadata cannot create provider model IDs or block their discovery.
      return { version, models: [] };
    } finally { await rm(home, { recursive: true, force: true }); }
  }
}
