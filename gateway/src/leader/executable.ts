import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

export function resolveCodexExecutable(override?: string): { executable: string; pathDirectory?: string } {
  if (override) return { executable: override };
  const platform = process.platform === "android" ? "linux" : process.platform;
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  const suffixes: Record<string, string | undefined> = { linux: "unknown-linux-musl", darwin: "apple-darwin", win32: "pc-windows-msvc" };
  const suffix = suffixes[platform];
  if (!architecture || !suffix) throw new Error("Unsupported Codex app-server platform");
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const codexRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
  const packageRoot = path.dirname(codexRequire.resolve(`@openai/codex-${platform}-${process.arch}/package.json`));
  const nativeRoot = path.join(packageRoot, "vendor", `${architecture}-${suffix}`);
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  for (const [binDirectory, pathDirectory] of [["bin", "codex-path"], ["codex", "path"]]) {
    const executable = path.join(nativeRoot, binDirectory, executableName);
    if (existsSync(executable)) return { executable, pathDirectory: path.join(nativeRoot, pathDirectory) };
  }
  throw new Error("Codex app-server binary is unavailable");
}
