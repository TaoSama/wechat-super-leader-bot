import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";

type HistoryFixtureOptions = {
  itemsPages: Record<string, unknown>;
  turnPages?: Record<string, unknown>;
  turnPagesByHome?: Record<string, Record<string, unknown>>;
  metadataMode?: "reject" | "timeout";
};

/** An isolated native-protocol process that refuses every state-changing RPC. */
export async function historyFixture(context: TestContext, options: HistoryFixtureOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-native-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "codex");
  const log = path.join(root, "protocol.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${JSON.stringify(options)};
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({ pid: process.pid }) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(message) + '\\n');
  if (message.method === 'initialized') return;
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === 'thread/items/list') return send({ id: message.id, result: options.itemsPages[message.params.cursor || ''] });
  if (message.method === 'thread/turns/list') {
    if (options.metadataMode === 'timeout') return;
    const pages = (options.turnPagesByHome || {})[process.env.CODEX_HOME] || options.turnPages || {};
    if (!options.metadataMode) return send({ id: message.id, result: pages[message.params.cursor || ''] || { data: [], nextCursor: null } });
  }
  send({ id: message.id, error: { code: -32601, message: 'private native diagnostic' } });
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  return { executable, async records(): Promise<Array<{ pid?: number; method?: string; params?: Record<string, unknown> }>> {
    return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  } };
}
