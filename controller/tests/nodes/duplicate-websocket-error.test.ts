import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const runNode = promisify(execFile);
const FIXTURE_TIMEOUT_MS = 30_000;

it("survives an invalid frame from a duplicate node during the closing handshake", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/duplicate-websocket-error.ts", import.meta.url));
  const { stdout, stderr } = await runNode(process.execPath, ["--import", "tsx", fixture], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    timeout: FIXTURE_TIMEOUT_MS,
    env: { ...process.env, SUPER_LEADER_NO_DOTENV: "1" },
  });

  expect(stderr).toContain("Invalid WebSocket frame: RSV1 must be clear");
  expect(stdout).toContain(JSON.stringify({
    duplicateCloseCode: 4009, healthyHttp: 200, nodeConnected: true, heartbeatAfterError: true,
  }));
}, FIXTURE_TIMEOUT_MS + 1_000);
