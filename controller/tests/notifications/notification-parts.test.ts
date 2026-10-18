import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createExecution, executionRequestId } from "../../src/leader/plans/execution.js";
import { createGoal, goalRequestId } from "../../src/leader/goals/goal.js";
import type { CommandRecord } from "../../src/types.js";
import { createTerminalNotifications, createGoalNotifications, normalizeNotification, terminalNotificationPartEligible,
  claimNotificationRecord, receiptNotificationRecord, NOTIFICATION_TEXT_BYTES } from "../../src/notifications/contracts.js";
import { splitNotificationText, splitNotificationTextChunks, NOTIFICATION_PART_LIMIT,
  NOTIFICATION_PART_TARGET_BYTES } from "../../src/notifications/parts.js";
import { planNotificationText, goalResultNotificationChunks } from "../../src/notifications/presentation.js";
import { proposal } from "../fixtures/goals.js";

const NOW = 1_700_000_000_000;
function digest(chunks: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk, "utf8");
  return hash.digest("hex");
}

function markerPosition(chunks: readonly string[], marker: string): number {
  let offset = 0, tail = "";
  for (const chunk of chunks) {
    const boundaryIndex = `${tail}${chunk.slice(0, marker.length - 1)}`.indexOf(marker);
    if (boundaryIndex !== -1) return offset - tail.length + boundaryIndex;
    const chunkIndex = chunk.indexOf(marker);
    if (chunkIndex !== -1) return offset + chunkIndex;
    tail = `${tail}${chunk.slice(-(marker.length - 1))}`.slice(-(marker.length - 1));
    offset += chunk.length;
  }
  return -1;
}

function maximalOutput(index: number, chinese: boolean): string {
  const start = `RESULT_START_${index}`, end = `RESULT_END_${index}`;
  const bytes = Buffer.alloc(NOTIFICATION_TEXT_BYTES, "A".charCodeAt(0) + index);
  if (chinese) {
    const character = Buffer.from(String.fromCharCode("中".charCodeAt(0) + index), "utf8");
    const bodyStart = Buffer.byteLength(start), bodyEnd = bytes.length - Buffer.byteLength(end);
    const completeCharactersEnd = bodyEnd - (bodyEnd - bodyStart) % character.length;
    bytes.fill(character, bodyStart, completeCharactersEnd);
  }
  bytes.write(start, 0, "utf8");
  bytes.write(end, bytes.length - Buffer.byteLength(end), "utf8");
  return bytes.toString("utf8");
}

function fixture(output: string) {
  const record = createExecution("chat", { id: randomUUID(), expiresAt: NOW + 60_000,
    actions: [{ nodeId: "node", sessionId: "session", prompt: "完整 Markdown", dependsOn: [], sendRoute: "control-socket" }] }, NOW);
  record.status = "completed"; record.attempts[0] = { token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 };
  const stamp = new Date(NOW).toISOString();
  const command: CommandRecord = { commandId: randomUUID(), requestId: executionRequestId(record, 0), nodeId: "node", sessionId: "session",
    prompt: "完整 Markdown", action: "send", sendRoute: "control-socket", turnId: "exact", status: "completed", output,
    createdAt: stamp, updatedAt: stamp, expiresAt: stamp };
  return { record, command };
}

it("publishes an exact eight-MiB output plus headers as lossless bounded terminal parts", () => {
  const output = "x".repeat(NOTIFICATION_TEXT_BYTES), { record, command } = fixture(output);
  const parts = createTerminalNotifications(record, NOW, [command]);
  expect(parts).toHaveLength(9); expect(parts[0].id).toBe(record.id); expect(parts[1].id).not.toBe(record.id);
  expect(parts.map(item => item.kind !== "progress" && item.part)).toEqual(
    Array.from({ length: parts.length }, (_, index) => ({ index: index + 1, total: parts.length })));
  const text = parts.map(item => item.text).join("");
  expect(text).toBe(planNotificationText(record, [command])); expect(text).toContain(output);
  expect(normalizeNotification({ ...parts[0], text: output }).text).toBe(output);
  for (const part of parts) expect(Buffer.byteLength(part.text, "utf8")).toBeLessThanOrEqual(NOTIFICATION_PART_TARGET_BYTES);
});

it.each([
  { alphabet: "ASCII", expectedParts: 109 },
  { alphabet: "Chinese", expectedParts: 121 },
])("preserves all twelve maximal $alphabet goal results instead of leaving the completed goal active", ({ alphabet, expectedParts }) => {
  const current = createGoal("chat", { ...proposal(NOW), maxActions: 12, maxDecisions: 24 }, NOW);
  const next = structuredClone(current); next.status = "completed";
  const stamp = new Date(NOW).toISOString(), target = next.proposal.targets[0];
  next.actions = Array.from({ length: 12 }, (_, index) => ({ index: index + 1, target: 1, prompt: `第 ${index + 1} 项`,
    sourceActions: [], input: { prompt: `frozen-${index}`, sources: [] },
    attempt: { token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 } }));
  const commands: CommandRecord[] = next.actions.map((action, index) => ({ commandId: randomUUID(), requestId: goalRequestId(next, index),
    nodeId: target.nodeId, sessionId: target.sessionId, sendRoute: target.sendRoute, prompt: action.input.prompt,
    action: "send", status: "completed", turnId: `exact-${index}`, output: maximalOutput(index, alphabet === "Chinese"),
    createdAt: stamp, updatedAt: stamp, expiresAt: stamp }));
  const parts = createGoalNotifications(current, next, NOW, commands);
  expect(parts).toHaveLength(expectedParts);
  expect(parts.length).toBeLessThanOrEqual(NOTIFICATION_PART_LIMIT);
  const texts = parts.map(item => item.text);
  expect(digest(texts)).toBe(digest(goalResultNotificationChunks(next, commands)));
  let previousEnd = -1;
  for (let index = 0; index < commands.length; index++) {
    const title = markerPosition(texts, `**${index + 1}. 第 ${index + 1} 项**`);
    const start = markerPosition(texts, `RESULT_START_${index}`), end = markerPosition(texts, `RESULT_END_${index}`);
    expect(title).toBeGreaterThan(previousEnd);
    expect(start).toBeGreaterThan(title);
    expect(end).toBeGreaterThan(start);
    expect(end - start + `RESULT_END_${index}`.length).toBe(commands[index].output!.length);
    expect(Buffer.byteLength(commands[index].output!, "utf8")).toBe(NOTIFICATION_TEXT_BYTES);
    previousEnd = end;
  }
  for (const part of parts) {
    expect(Buffer.byteLength(part.text, "utf8")).toBeLessThanOrEqual(NOTIFICATION_PART_TARGET_BYTES);
    expect(part.text).not.toContain("�");
  }
});

it("splits UTF-8 only at Unicode boundaries and retains whitespace-only continuation parts", () => {
  const unicode = `${"x".repeat(NOTIFICATION_TEXT_BYTES - 1)}😀末尾`;
  const unicodeParts = splitNotificationText(unicode);
  expect(unicodeParts.join("")).toBe(unicode);
  for (const part of unicodeParts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(NOTIFICATION_PART_TARGET_BYTES);
  const { record, command } = fixture(`开始${" ".repeat(2 * NOTIFICATION_TEXT_BYTES)}末尾`);
  const parts = createTerminalNotifications(record, NOW, [command]);
  const whitespace = parts.find(part => part.text.length > 0 && part.text.trim() === "");
  expect(whitespace).toBeDefined(); expect(normalizeNotification(whitespace)).toEqual(whitespace);
  expect(parts.map(item => item.text).join("")).toBe(planNotificationText(record, [command]));
  for (const part of parts) expect(Buffer.byteLength(part.text, "utf8")).toBeLessThanOrEqual(NOTIFICATION_PART_TARGET_BYTES);
  expect(() => splitNotificationText("invalid\ud800")).toThrow("invalid Unicode");
});

it("retains Unicode code points split between input chunks and across the eight-MiB byte boundary", () => {
  const prefix = "x".repeat(NOTIFICATION_TEXT_BYTES - 1);
  const chunks = [prefix, "\ud83d", "\ude00", "中", "\ud83d", "\ude80", "末尾"];
  const parts = splitNotificationTextChunks(chunks);
  expect(parts.join("")).toBe(`${prefix}😀中🚀末尾`);
  expect(parts).toHaveLength(9);
  for (const part of parts) {
    expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(NOTIFICATION_PART_TARGET_BYTES);
    expect(part).not.toContain("�");
  }
  expect(() => splitNotificationTextChunks(["ok", "\ud800", "invalid"])).toThrow("invalid Unicode");
  expect(() => splitNotificationTextChunks(["ok", "\udc00"])).toThrow("invalid Unicode");
  expect(() => splitNotificationTextChunks(["ok", "\ud800"])).toThrow("invalid Unicode");
});

it("preserves empty input chunks and whitespace-only continuation without adding text", () => {
  const whitespace = " ".repeat(NOTIFICATION_TEXT_BYTES);
  const chunks = ["", "开始\n", "", whitespace, "", "\n末尾", ""];
  const parts = splitNotificationTextChunks(chunks);
  expect(digest(parts)).toBe(digest(chunks));
  expect(parts.some(part => part.length > 0 && part.trim() === "")).toBe(true);
  for (const part of parts) expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(NOTIFICATION_PART_TARGET_BYTES);
  expect(splitNotificationTextChunks(["", ""])).toEqual([""]);
});

it("rejects the 129th full part without materializing the complete input", () => {
  const chunk = Buffer.alloc(NOTIFICATION_PART_TARGET_BYTES, "x").toString("utf8");
  let visited = 0;
  function* chunks(): Generator<string> {
    while (true) { visited++; yield chunk; }
  }
  expect(() => splitNotificationTextChunks(chunks())).toThrow("multipart result budget");
  expect(visited).toBe(NOTIFICATION_PART_LIMIT + 1);
});

it("normalizes terminal metadata into independent nested objects without copying immutable text", () => {
  const { record, command } = fixture("精确正文");
  const input = { ...createTerminalNotifications(record, NOW, [command])[0], part: { index: 1, total: 2 } };
  const normalized = normalizeNotification(input);
  if (normalized.kind === "progress") throw new Error("Expected a terminal notification");
  expect(normalized).not.toBe(input);
  expect(normalized.source).not.toBe(input.source);
  expect(normalized.part).not.toBe(input.part);
  expect(normalized.text).toBe(input.text);
  normalized.source.id = randomUUID();
  normalized.part!.index = 2;
  expect(input.source.id).toBe(record.id);
  expect(input.part).toEqual({ index: 1, total: 2 });
});

it("does not release later parts until every predecessor is explicitly accepted", () => {
  const { record, command } = fixture("x".repeat(NOTIFICATION_TEXT_BYTES));
  const parts = createTerminalNotifications(record, NOW, [command]);
  expect(terminalNotificationPartEligible(parts[0], parts)).toBe(true);
  expect(terminalNotificationPartEligible(parts[1], parts)).toBe(false);
  const attempt = randomUUID(); parts[0] = claimNotificationRecord(parts[0], attempt, ["chat"], NOW);
  expect(terminalNotificationPartEligible(parts[1], parts)).toBe(false);
  parts[0] = receiptNotificationRecord(parts[0], attempt, "uncertain", NOW);
  expect(terminalNotificationPartEligible(parts[1], parts)).toBe(false);
  parts[0] = receiptNotificationRecord(parts[0], attempt, "accepted", NOW);
  expect(terminalNotificationPartEligible(parts[1], parts)).toBe(true);
  const mismatched = { ...parts[0], part: { index: 1, total: 3 } };
  expect(terminalNotificationPartEligible(parts[1], [mismatched, parts[1]])).toBe(false);
});
