import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundArtifacts, BACKGROUND_ARTIFACT_RETENTION_MS, BACKGROUND_ARTIFACT_ROUTE } from "../src/runtime/background-artifacts.js";
import { MemoryBackgroundRepository } from "../src/background/memory.js";
import type { BackgroundInvocation, BackgroundWorker } from "../src/background/contracts.js";
import type { WorkerArtifact } from "../src/background/worker/contracts.js";

const NOW = Date.parse("2026-10-18T01:00:00Z");
const SECRET = "test-background-download-secret-at-least-32-chars";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  let now = NOW;
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "background-artifacts-test-")));
  const root = path.join(temporary, "exports");
  const workspace = path.join(temporary, "workspace");
  fs.mkdirSync(workspace);
  const workerId = randomUUID(); const invocationId = randomUUID();
  const dir = path.join(root, workerId, invocationId);
  fs.mkdirSync(dir, { recursive: true });
  const content = Buffer.from("这是保留的报告\n");
  const artifact: WorkerArtifact = { name: "报告.html", path: path.join(dir, "0-报告.html"), size: content.length,
    sha256: createHash("sha256").update(content).digest("hex") };
  fs.writeFileSync(artifact.path, content);
  const invocation: BackgroundInvocation = { id: invocationId, kind: "initial", task: "生成报告", input: {},
    createdAt: now, status: "completed", exported: true, receipt: { status: "completed", artifacts: [artifact] } };
  const worker: BackgroundWorker = { id: workerId, runId: randomUUID(), scheduleId: randomUUID(), chatId: "allowed",
    scheduledAt: now, spec: { prompt: "报告", sources: [], preferences: [], deadlineMs: 3_600_000, checkIntervalsMs: [120_000] },
    createdAt: now, updatedAt: now, expiresAt: now + 86_400_000, deadlineAt: now + 3_600_000,
    phase: "completed", checkCount: 0, nextCheckAt: now, observations: [], prompts: [], invocations: [invocation], leaseUntil: 0 };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ workerId, invocationId, artifacts: [artifact] }));
  const repository = new MemoryBackgroundRepository(); await repository.create(worker);
  const allowed = new Set(["allowed"]);
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const publicUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const service = new BackgroundArtifacts({ root, publicUrl, secret: SECRET, repository, allowed: () => allowed, now: () => now });
  app.use(BACKGROUND_ARTIFACT_ROUTE, service.router());
  cleanups.push(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const links = () => service.links(worker, invocation, [artifact]);
  return { service, root, dir, workspace, temporary, publicUrl, worker, invocation, artifact, content,
    repository, allowed, links, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("retained isolated-worker artifact delivery", () => {
  it("retains revoked exports for bounded disposal without granting a download link", async () => {
    const f = await fixture();
    await expect(f.service.retainDiscarded(f.worker, f.invocation, [f.artifact])).rejects.toThrow("revoked or cancelled");
    f.allowed.clear();
    await expect(f.service.retainDiscarded(f.worker, f.invocation, [f.artifact])).resolves.toBeUndefined();
    await expect(f.links()).rejects.toThrow("unavailable");
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].discardedAt = f.now(); });
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    f.advance(BACKGROUND_ARTIFACT_RETENTION_MS);
    expect(await f.service.maintenance()).toEqual({ removed: 1 });
    expect(fs.existsSync(f.dir)).toBe(false);
    expect((await f.repository.get(f.worker.id))?.invocations[0].acceptedAt).toBeUndefined();
  });

  it("serves a signed exact export as attachment after workspace cleanup and process recreation", async () => {
    const f = await fixture();
    const [url] = await f.links();
    expect(url).not.toContain(f.root);
    expect(new URL(url).pathname).toBe(`${BACKGROUND_ARTIFACT_ROUTE}/${f.worker.id}/${f.invocation.id}/0/download`);
    fs.rmSync(f.workspace, { recursive: true });
    await f.repository.update(f.worker.id, worker => { worker.phase = "cleaned"; worker.cleanedAt = f.now(); });
    f.advance(25 * 60 * 60_000);
    const fresh = new BackgroundArtifacts({ root: f.root, publicUrl: f.publicUrl, secret: SECRET,
      repository: f.repository, allowed: () => f.allowed, now: f.now });
    expect(await fresh.links(f.worker, f.invocation, [f.artifact])).toEqual([url]);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.content);
    expect(response.headers.get("content-type")).toContain("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("rejects invalid signatures, edited expiry, indexes and occurrence identities", async () => {
    const f = await fixture(); const [url] = await f.links();
    const changedSignature = new URL(url); changedSignature.searchParams.set("signature", "0".repeat(64));
    const changedExpiry = new URL(url); changedExpiry.searchParams.set("expires", String(NOW + 99_999));
    const changedIndex = new URL(url); changedIndex.pathname = changedIndex.pathname.replace("/0/download", "/1/download");
    for (const changed of [changedSignature, changedExpiry, changedIndex]) expect((await fetch(changed)).status).toBe(403);
    const changedWorker = new URL(url); changedWorker.pathname = changedWorker.pathname.replace(f.worker.id, randomUUID());
    expect((await fetch(changedWorker)).status).toBe(404);
    const changedInvocation = new URL(url); changedInvocation.pathname = changedInvocation.pathname.replace(f.invocation.id, randomUUID());
    expect((await fetch(changedInvocation)).status).toBe(404);
    const noSignature = new URL(url); noSignature.searchParams.delete("signature");
    expect((await fetch(noSignature)).status).toBe(403);
  });
  it("honors chat revocation and refuses cross-chat ownership changes", async () => {
    const f = await fixture(); const [url] = await f.links();
    f.allowed.clear();
    expect((await fetch(url)).status).toBe(404);
    await expect(f.links()).rejects.toThrow("unavailable for this chat");
    f.allowed.add("allowed"); f.allowed.add("another-chat");
    await f.repository.update(f.worker.id, worker => { worker.chatId = "another-chat"; });
    expect((await fetch(url)).status).toBe(404);
    await expect(f.links()).rejects.toThrow("unavailable for this chat");
  });
  it("does not reveal backend errors or local paths when ownership storage is unavailable", async () => {
    const f = await fixture(); const [url] = await f.links();
    vi.spyOn(f.repository, "get").mockRejectedValueOnce(new Error(`database unavailable ${f.root}`));
    const response = await fetch(url);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(f.root);
  });
  it("refuses files whose receipt, runtime manifest or bytes differ from the exact export", async () => {
    const f = await fixture(); const [url] = await f.links();
    fs.writeFileSync(f.artifact.path, "tampered contents");
    const response = await fetch(url);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(f.root);
    await expect(f.links()).rejects.toThrow("integrity");
    fs.writeFileSync(f.artifact.path, f.content);
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].receipt!.artifacts![0].sha256 = "0".repeat(64); });
    expect((await fetch(url)).status).toBe(404);
    fs.writeFileSync(path.join(f.dir, "result.json"), JSON.stringify({ workerId: randomUUID(), invocationId: f.invocation.id, artifacts: [f.artifact] }));
    await expect(f.links()).rejects.toThrow("runtime export receipt");
  });
  it("rejects symlinks, hardlinks and paths outside the exact export directory", async () => {
    const f = await fixture(); const [url] = await f.links();
    const outside = path.join(f.temporary, "outside.txt"); fs.writeFileSync(outside, f.content);
    await expect(f.service.links(f.worker, f.invocation, [{ ...f.artifact, path: outside }])).rejects.toThrow("exact export");
    fs.unlinkSync(f.artifact.path); fs.symlinkSync(outside, f.artifact.path);
    expect((await fetch(url)).status).toBe(409);
    await expect(f.links()).rejects.toThrow();
    fs.unlinkSync(f.artifact.path); fs.linkSync(outside, f.artifact.path);
    expect((await fetch(url)).status).toBe(409);
    await expect(f.links()).rejects.toThrow("ordinary file");
    fs.unlinkSync(f.artifact.path); fs.copyFileSync(outside, f.artifact.path);
    const realDir = path.join(f.temporary, "moved-export"); fs.renameSync(f.dir, realDir); fs.symlinkSync(realDir, f.dir);
    expect((await fetch(url)).status).toBe(409);
    await expect(f.links()).rejects.toThrow("Unsafe artifact directory");
  });
  it("expires fixed links after seven days without extending retention on reads", async () => {
    const f = await fixture(); const [url] = await f.links();
    f.advance(BACKGROUND_ARTIFACT_RETENTION_MS - 1);
    expect(await f.links()).toEqual([url]);
    expect((await fetch(url)).status).toBe(200);
    f.advance(1);
    expect((await fetch(url)).status).toBe(410);
    await expect(f.links()).rejects.toThrow("expired");
  });
  it("cleans only expired exports already accepted by the outbox", async () => {
    const f = await fixture(); const [url] = await f.links();
    const untouched = path.join(f.root, "unrelated"); fs.mkdirSync(untouched); fs.writeFileSync(path.join(untouched, "keep"), "keep");
    const unmarked = path.join(f.root, f.worker.id, randomUUID()); fs.mkdirSync(unmarked); fs.writeFileSync(path.join(unmarked, "keep"), "keep");
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].acceptedAt = f.now(); });
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    f.advance(BACKGROUND_ARTIFACT_RETENTION_MS);
    await f.repository.update(f.worker.id, worker => { delete worker.invocations[0].acceptedAt; });
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    expect(fs.existsSync(f.artifact.path)).toBe(true);
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].acceptedAt = f.now(); worker.activeInvocationId = f.invocation.id; });
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    await f.repository.update(f.worker.id, worker => { delete worker.activeInvocationId; });
    expect(await f.service.maintenance()).toEqual({ removed: 1 });
    expect(fs.existsSync(f.dir)).toBe(false);
    expect(fs.existsSync(untouched)).toBe(true); expect(fs.existsSync(unmarked)).toBe(true);
    expect((await fetch(url)).status).toBe(404);
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
  });
  it("keeps exports with unknown entries and does not traverse linked cleanup targets", async () => {
    const f = await fixture(); await f.links();
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].acceptedAt = f.now(); });
    f.advance(BACKGROUND_ARTIFACT_RETENTION_MS);
    fs.writeFileSync(path.join(f.dir, "unrelated"), "keep");
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    fs.unlinkSync(path.join(f.dir, "unrelated"));
    const outside = path.join(f.temporary, "outside"); fs.writeFileSync(outside, "keep");
    fs.unlinkSync(f.artifact.path); fs.symlinkSync(outside, f.artifact.path);
    await expect(f.service.maintenance()).rejects.toThrow("Unsafe expired artifact export");
    expect(fs.readFileSync(outside, "utf8")).toBe("keep"); expect(fs.existsSync(f.dir)).toBe(true);
  });
  it("rotates bounded maintenance batches and removes only known empty worker parents", async () => {
    const f = await fixture(); await f.links();
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].acceptedAt = f.now(); });
    f.advance(BACKGROUND_ARTIFACT_RETENTION_MS);
    const unknownDirectories = Array.from({ length: 8 }, () => path.join(f.root, randomUUID()));
    for (const directory of unknownDirectories) fs.mkdirSync(directory);
    const bounded = new BackgroundArtifacts({ root: f.root, publicUrl: f.publicUrl, secret: SECRET,
      repository: f.repository, allowed: () => f.allowed, now: f.now, maintenanceBatchSize: 1 });
    const get = vi.spyOn(f.repository, "get");
    let removed = 0;
    try {
      for (let batch = 0; batch < 40 && fs.existsSync(path.dirname(f.dir)); batch++) {
        const before = get.mock.calls.length;
        removed += (await bounded.maintenance()).removed;
        expect(get.mock.calls.length - before).toBeLessThanOrEqual(1);
      }
    } finally { await bounded.close(); }
    expect(removed).toBe(1);
    expect(fs.existsSync(path.dirname(f.dir))).toBe(false);
    expect(unknownDirectories.every(directory => fs.existsSync(directory))).toBe(true);
  });
  it("removes a known empty export parent but preserves unrelated empty UUID directories", async () => {
    const f = await fixture();
    const knownId = randomUUID(); const unknownId = randomUUID();
    await f.repository.create({ ...f.worker, id: knownId, runId: randomUUID(), invocations: [] });
    const known = path.join(f.root, knownId); const unknown = path.join(f.root, unknownId);
    fs.mkdirSync(known); fs.mkdirSync(unknown);
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    expect(fs.existsSync(known)).toBe(false); expect(fs.existsSync(unknown)).toBe(true);
  });
  it("reclaims expired exports explicitly discarded by the user without pretending outbox acceptance", async () => {
    const f = await fixture(); await f.links();
    await f.repository.update(f.worker.id, worker => { worker.invocations[0].discardedAt = f.now(); });
    expect((await f.repository.get(f.worker.id))?.invocations[0].acceptedAt).toBeUndefined();
    expect(await f.service.maintenance()).toEqual({ removed: 0 });
    f.advance(BACKGROUND_ARTIFACT_RETENTION_MS);
    expect(await f.service.maintenance()).toEqual({ removed: 1 });
    expect(fs.existsSync(path.dirname(f.dir))).toBe(false);
    expect((await f.repository.get(f.worker.id))?.invocations[0].acceptedAt).toBeUndefined();
  });
  it("supports configured retention and refuses insecure configuration", async () => {
    const f = await fixture();
    const options = { root: f.root, publicUrl: f.publicUrl, secret: SECRET, repository: f.repository, allowed: () => f.allowed, now: f.now };
    for (const patch of [{ secret: "short" }, { retentionMs: 0 }, { publicUrl: "file:///tmp" }, { root: "/" }, { maintenanceBatchSize: 0 }]) {
      expect(() => new BackgroundArtifacts({ ...options, ...patch })).toThrow();
    }
    const service = new BackgroundArtifacts({ ...options, retentionMs: 60_000 });
    const [url] = await service.links(f.worker, f.invocation, [f.artifact]);
    expect(new URL(url).searchParams.get("expires")).toBe(String(NOW + 60_000));
  });
});
