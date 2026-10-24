import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { GatewayModelCatalog, MODEL_CATALOG_TTL_MS, parseModelCatalog } from "../../src/settings/models.js";

const MODEL = { slug: "test-model", display_name: "Test Model", description: "Test", visibility: "list",
  default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "medium" }],
  context_window: 272_000, max_context_window: 872_000, base_instructions: "must-not-publish", model_messages: { secret: true } };

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-models-"));
  const executable = path.join(root, "codex");
  const mode = path.join(root, "mode");
  const log = path.join(root, "log.jsonl");
  await writeFile(mode, "normal");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\\n');
if (process.argv.includes('--version')) process.stdout.write('codex-cli 0.163.0\\n');
else if (mode === 'fail') { console.error('secret-do-not-publish'); process.exit(2); }
else if (mode === 'timeout') setInterval(() => {}, 1000);
else if (mode === 'oversized') process.stdout.write('x'.repeat(17 * 1024 * 1024));
else if (mode === 'invalid') process.stdout.write('not-json');
else process.stdout.write(${JSON.stringify(JSON.stringify({ models: [MODEL, { ...MODEL, slug: "hidden", visibility: "hide" }] }))});
`, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));
  let payload: unknown = { data: [{ id: "test-model" }, { id: "new-provider-model" }] };
  let status = 200;
  let redirect: string | undefined;
  const requests: { url?: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.statusCode = status;
    if (redirect) response.setHeader("location", redirect);
    response.setHeader("content-type", "application/json");
    if (payload === "pending-response") { response.write('{"data":['); return; }
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return { root, executable, mode, log, baseUrl, requests,
    provider(value: unknown, nextStatus = 200, location?: string) { payload = value; status = nextStatus; redirect = location; },
    async records() {
    return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  } };
}

test("catalog parser exposes metadata and preserves model-specific reasoning choices", () => {
  const models = parseModelCatalog(JSON.stringify({ models: [MODEL, { ...MODEL, slug: "hidden", visibility: "hide" }] }));
  assert.equal(models[0].id, "test-model");
  assert.equal(models[0].displayName, "Test Model");
  assert.equal(models[0].defaultReasoningEffort, "medium");
  assert.deepEqual(models[0].supportedReasoningEfforts.map(item => item.reasoningEffort), ["low", "medium"]);
  assert.equal(models[0].contextWindow, 272_000);
  assert.equal(models[0].maxContextWindow, 872_000);
  assert.equal(models[0].hidden, false);
  assert.equal(models[1].hidden, true);
  assert(!JSON.stringify(models).includes("must-not-publish"));
  assert(!JSON.stringify(models).includes("model_messages"));
  assert.throws(() => parseModelCatalog(JSON.stringify({ models: [MODEL, MODEL] })));
  assert.deepEqual(parseModelCatalog(JSON.stringify({ data: [] })), []);
  assert.throws(() => parseModelCatalog(JSON.stringify({ models: [{ ...MODEL, supported_reasoning_levels: "low" }] })));
});

test("missing credentials never launch CLI or use host authentication", async context => {
  const fake = await fixture(context);
  const catalog = new GatewayModelCatalog({ stateRoot: fake.root, codexPath: fake.executable });
  assert.equal((await catalog.refresh()).error, "missing-api-key");
  assert.equal((await catalog.snapshot()).status, "unavailable");
  await assert.rejects(readFile(fake.log), { code: "ENOENT" });
});

test("refresh isolates provider identity, config, credentials and homes and saves sanitized metadata", async context => {
  const fake = await fixture(context);
  const options = { stateRoot: fake.root, apiKey: "gateway-api-key", baseUrl: fake.baseUrl, codexPath: fake.executable };
  const catalog = new GatewayModelCatalog(options);
  assert.equal((await catalog.snapshot()).status, "unavailable");
  const [first, second] = await Promise.all([catalog.refresh(), catalog.refresh()]);
  assert.deepEqual(first, second);
  assert.equal(first.status, "ready");
  assert.equal(first.cliVersion, "codex-cli 0.163.0");
  assert.equal(first.freshness, "upstream-cache-possible");
  assert.deepEqual(first.provider, { id: "leader_openai", baseUrl: new URL(fake.baseUrl).origin });
  assert.deepEqual(first.models.map(model => model.id), ["test-model", "new-provider-model"]);
  assert.equal(first.models[0].metadataSource, "codex-cache");
  assert.equal(first.models[0].contextWindow, 272_000);
  assert.deepEqual(first.models[1].supportedReasoningEfforts, []);
  assert.deepEqual(fake.requests, [{ url: "/v1/models", authorization: "Bearer gateway-api-key" }]);
  assert(!JSON.stringify(first).includes(options.apiKey));
  assert(!JSON.stringify(first).includes(fake.root));
  const records = await fake.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].args, ["--version"]);
  const launch = records[1];
  assert.deepEqual(launch.args.slice(0, 2), ["debug", "models"]);
  assert(launch.args.includes('forced_login_method="api"'));
  assert(launch.args.includes('model_provider="leader_openai"'));
  assert(launch.args.some((value: string) => value.includes(`base_url=${JSON.stringify(fake.baseUrl)}`) && value.includes('env_key="CODEX_API_KEY"')));
  assert(!launch.args.includes("--bundled"));
  assert(!launch.args.join(" ").includes(options.apiKey));
  assert.equal(launch.env.CODEX_API_KEY, options.apiKey);
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.CODEX_HOME, launch.env.HOME);
  assert.equal(launch.cwd, await realpath(launch.env.HOME));
  assert(launch.env.HOME.startsWith(path.join(fake.root, "settings", "models")));
  assert.equal((await stat(launch.env.HOME)).mode & 0o777, 0o700);
  const cache = path.join(path.dirname(launch.env.HOME), "catalog.json");
  assert.equal((await stat(cache)).mode & 0o777, 0o600);
  assert(!String(await readFile(cache)).includes("must-not-publish"));
  assert.deepEqual(await new GatewayModelCatalog(options).snapshot(), first);
  assert.equal((await new GatewayModelCatalog({ ...options, apiKey: "another-key" }).snapshot()).status, "unavailable");
  assert.equal((await new GatewayModelCatalog({ ...options, baseUrl: "https://different.example.test/v1" }).snapshot()).status, "unavailable");
  assert.deepEqual((await readdir(path.dirname(cache))).sort(), ["catalog.json", "home"]);
});

test("failed refresh retains cached models without surfacing stderr or credential details", async context => {
  const fake = await fixture(context);
  const catalog = new GatewayModelCatalog({ stateRoot: fake.root, apiKey: "gateway-key", codexPath: fake.executable, baseUrl: fake.baseUrl });
  const first = await catalog.refresh();
  fake.provider({ error: "secret-do-not-publish" }, 401);
  const failed = await catalog.refresh();
  assert.equal(failed.status, "stale");
  assert.equal(failed.error, "refresh-failed");
  assert.deepEqual(failed.models, first.models);
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert(!JSON.stringify(failed).includes("secret"));
  assert.equal((await catalog.snapshot()).status, "stale");
  const options = { stateRoot: fake.root, apiKey: "gateway-key", codexPath: fake.executable, baseUrl: fake.baseUrl };
  assert.equal((await new GatewayModelCatalog(options).snapshot()).status, "stale");
  fake.provider({ data: [{ id: "recovered-model" }] });
  assert.equal((await catalog.refresh()).status, "ready");
  assert.equal((await catalog.snapshot()).status, "ready");
  assert.equal((await new GatewayModelCatalog(options).snapshot()).status, "ready");
});

test("expired provider cache is stale without network access or changing its last success time", async context => {
  const fake = await fixture(context);
  const options = { stateRoot: fake.root, apiKey: "key", baseUrl: fake.baseUrl, codexPath: fake.executable };
  const catalog = new GatewayModelCatalog(options);
  await catalog.refresh();
  const launch = (await fake.records())[0];
  const cache = path.join(path.dirname(launch.env.HOME), "catalog.json");
  const payload = JSON.parse(await readFile(cache, "utf8"));
  payload.fetchedAt = new Date(Date.now() - MODEL_CATALOG_TTL_MS - 1_000).toISOString();
  await writeFile(cache, JSON.stringify(payload));
  const requests = fake.requests.length;
  const stale = await new GatewayModelCatalog(options).snapshot();
  assert.equal(stale.status, "stale");
  assert.equal(stale.error, "cache-expired");
  assert.equal(stale.fetchedAt, payload.fetchedAt);
  assert.equal(fake.requests.length, requests);
});

for (const mode of ["timeout", "oversized", "invalid"]) {
  test(`CLI ${mode} is bounded and cannot hide dynamically discovered provider models`, async context => {
    const fake = await fixture(context);
    await writeFile(fake.mode, mode);
    const started = Date.now();
    const catalog = new GatewayModelCatalog({ stateRoot: fake.root, apiKey: "gateway-key", codexPath: fake.executable, baseUrl: fake.baseUrl,
      timeoutMs: mode === "timeout" ? 5_000 : 20_000 });
    const snapshot = await catalog.refresh();
    assert.equal(snapshot.status, "ready");
    assert.deepEqual(snapshot.models.map(model => model.id), ["test-model", "new-provider-model"]);
    assert.deepEqual(snapshot.models[0].supportedReasoningEfforts, []);
    const records = await fake.records();
    const launches = records.length;
    assert(mode === "timeout" ? launches >= 1 : launches === 2);
    for (const record of records) assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
    assert(Date.now() - started < 50_000);
  });
}

test("provider URLs cannot smuggle credentials into the catalog or CLI config", () => {
  for (const baseUrl of ["https://name:password@api.test/v1", "https://api.test/v1?key=secret", "https://api.test/v1#secret", "file:///tmp/provider"]) {
    assert.throws(() => new GatewayModelCatalog({ stateRoot: "/tmp", apiKey: "key", baseUrl }));
  }
});

test("provider metadata is accepted and remains authoritative over cached reasoning metadata", async context => {
  const fake = await fixture(context);
  fake.provider({ models: [{ ...MODEL, supported_reasoning_levels: [{ effort: "none" }], context_window: 100_000 }] });
  const snapshot = await new GatewayModelCatalog({ stateRoot: fake.root, apiKey: "key", baseUrl: fake.baseUrl, codexPath: fake.executable }).refresh();
  assert.equal(snapshot.status, "ready");
  assert.deepEqual(snapshot.models[0].supportedReasoningEfforts, [{ reasoningEffort: "none", description: undefined }]);
  assert.equal(snapshot.models[0].contextWindow, 100_000);
});

test("provider redirects are rejected without forwarding authentication", async context => {
  const fake = await fixture(context);
  fake.provider({}, 302, fake.baseUrl + "/stolen");
  const snapshot = await new GatewayModelCatalog({ stateRoot: fake.root, apiKey: "key", baseUrl: fake.baseUrl, codexPath: fake.executable }).refresh();
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.error, "refresh-failed");
  assert.equal(fake.requests.length, 1);
});

for (const payload of ["pending-response", "x".repeat(17 * 1024 * 1024), { data: [{ id: "duplicate" }, { id: "duplicate" }] }]) {
  test("provider timeout, oversized payload and malformed lists fail without bundled fallback", async context => {
    const fake = await fixture(context);
    fake.provider(payload);
    const snapshot = await new GatewayModelCatalog({ stateRoot: fake.root, apiKey: "key", baseUrl: fake.baseUrl,
      codexPath: fake.executable, timeoutMs: 1_000 }).refresh();
    assert.equal(snapshot.status, "unavailable");
    assert.equal(snapshot.error, "refresh-failed");
    assert.deepEqual(snapshot.models, []);
  });
}

test("symlinked state directories cannot redirect model cache or private CLI home", async context => {
  const fake = await fixture(context);
  const elsewhere = path.join(fake.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, path.join(fake.root, "settings"), "dir");
  const catalog = new GatewayModelCatalog({ stateRoot: fake.root, apiKey: "gateway-key", codexPath: fake.executable });
  assert.equal((await catalog.snapshot()).error, "cache-unavailable");
  assert.equal((await catalog.refresh()).status, "unavailable");
  assert.deepEqual(await readdir(elsewhere), []);
  await assert.rejects(readFile(fake.log), { code: "ENOENT" });
});
