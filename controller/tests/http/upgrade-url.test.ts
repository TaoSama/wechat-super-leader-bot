import { fork } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const IO_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;
const NODE_TOKEN = "upgrade-test-node-token";

function upgradeResponse(port: number, target: string, token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy(new Error("Upgrade response timed out")));
    socket.on("error", reject);
    socket.on("data", chunk => { response += chunk; });
    socket.on("end", () => { socket.destroy(); resolve(response); });
    socket.on("connect", () => socket.write([
      `GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...(token ? [`Authorization: Bearer ${token}`] : []), "", "",
    ].join("\r\n")));
  });
}

describe("Upgrade URL boundary", () => {
  it("rejects malformed targets without exiting and preserves daemon authentication", async () => {
    // A separate process proves an uncaught upgrade exception cannot take down the test runner.
    const child = fork(fileURLToPath(new URL("../fixtures/upgrade-controller.ts", import.meta.url)), {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, SUPER_LEADER_NO_DOTENV: "1" },
    });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Isolated server startup timed out: ${stderr}`)), STARTUP_TIMEOUT_MS);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`Isolated server exited: ${code}/${signal}: ${stderr}`));
        });
        child.once("message", message => {
          clearTimeout(timer);
          const ready = message as { port?: number };
          if (!ready.port) reject(new Error("Isolated server did not provide a port"));
          else resolve(ready.port);
        });
      });

      for (const token of [undefined, NODE_TOKEN]) {
        const response = await upgradeResponse(port, "//[", token);
        expect(response, stderr).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
        expect(child.exitCode).toBeNull();
        expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      }
      expect(await upgradeResponse(port, "/missing", NODE_TOKEN)).toMatch(/^HTTP\/1\.1 404/);
      expect(await upgradeResponse(port, "/v1/daemon")).toMatch(/^HTTP\/1\.1 401/);
      expect(await upgradeResponse(port, "/v1/daemon", "wrong-token")).toMatch(/^HTTP\/1\.1 403/);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/daemon`, {
        headers: { authorization: `Bearer ${NODE_TOKEN}` }, handshakeTimeout: IO_TIMEOUT_MS,
      });
      try {
        await once(ws, "open");
        expect(ws.readyState).toBe(WebSocket.OPEN);
        const closed = once(ws, "close");
        ws.close();
        await closed;
      } finally {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
  }, TEST_TIMEOUT_MS);
});
