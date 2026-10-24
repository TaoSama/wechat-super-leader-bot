import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { MESSAGE_IMAGE_TTL_MS, type StoredMessageImage } from "../../src/sessions/message-images.js";
import type { MessageRecord, Session } from "../../src/types.js";

const CHAT_ID = "snapshot-chat";
const MESSAGE_ID = "snapshot-message";
const NODE_ID = "snapshot-node";
const OBSERVED_AT = "2026-10-23T00:00:00.000Z";
const IMAGE_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function image(): StoredMessageImage {
  return { id: randomUUID(), mime: "image/png", size: IMAGE_BYTES.length,
    sha256: createHash("sha256").update(IMAGE_BYTES).digest("hex"), data: Buffer.from(IMAGE_BYTES) };
}

function message(): MessageRecord {
  const { data: _data, ...descriptor } = image();
  return { chatId: CHAT_ID, messageId: MESSAGE_ID, text: "show the image", replyText: "image reply",
    images: [descriptor], createdAt: OBSERVED_AT };
}

describe("MemoryStore snapshot isolation", () => {
  it("preserves the first message when its caller mutates image descriptors and the array", async () => {
    const store = new MemoryStore();
    const original = message(), expected = structuredClone(original);
    await store.recordMessage(original);

    original.images![0].id = randomUUID();
    original.images!.push({ ...original.images![0], id: randomUUID() });
    await store.recordMessage({ ...original, replyText: "replacement reply" });

    expect(await store.getMessage(CHAT_ID, MESSAGE_ID)).toEqual(expected);
    expect(await store.getMessage("other-chat", MESSAGE_ID)).toBeNull();
    expect(await store.getMessage(CHAT_ID, "other-message")).toBeNull();
  });

  it("isolates image descriptor and array mutations on message lookup results", async () => {
    const store = new MemoryStore(), original = message();
    const expected = structuredClone(original);
    await store.recordMessage(original);

    const descriptorSnapshot = (await store.getMessage(CHAT_ID, MESSAGE_ID))!;
    descriptorSnapshot.images![0].id = randomUUID();
    descriptorSnapshot.images![0].sha256 = "0".repeat(64);
    expect(await store.getMessage(CHAT_ID, MESSAGE_ID)).toEqual(expected);

    const arraySnapshot = (await store.getMessage(CHAT_ID, MESSAGE_ID))!;
    arraySnapshot.images!.length = 0;
    expect(await store.getMessage(CHAT_ID, MESSAGE_ID)).toEqual(expected);
  });

  it("copies frozen image metadata and Buffer bytes through the store API", async () => {
    const store = new MemoryStore(), original = image(), now = Date.now();
    const imageId = original.id;
    const expected = { ...original, data: Buffer.from(original.data) };
    const references = await store.recordMessageImages(CHAT_ID, MESSAGE_ID, [original], now + MESSAGE_IMAGE_TTL_MS);

    original.id = randomUUID();
    original.data.fill(0);
    references[0].id = randomUUID();
    const stored = (await store.getMessageImage(CHAT_ID, MESSAGE_ID, imageId, now))!;
    expect(stored).toEqual(expected);
    expect(Buffer.isBuffer(stored.data)).toBe(true);

    stored.id = randomUUID();
    stored.data.fill(0);
    expect(await store.getMessageImage(CHAT_ID, MESSAGE_ID, imageId, now)).toEqual(expected);
  });

  it("isolates nested session observations and capabilities on input and lookup", async () => {
    const store = new MemoryStore();
    const original: Session = { id: "snapshot-session", provider: "codex-app", title: "snapshot", cwd: "/fixture",
      status: "idle", capabilities: ["read", "send"], observedAt: OBSERVED_AT,
      desktopObservation: { source: "codex-desktop", availability: "available", status: "idle", observedAt: OBSERVED_AT },
      sendAvailability: { route: "desktop-owner", state: "ready", observedAt: OBSERVED_AT,
        validUntil: "2026-10-23T00:00:30.000Z" } };
    const expected = structuredClone(original), inventory = [original];
    await store.upsertNodeSessions(NODE_ID, inventory);

    inventory.length = 0;
    original.capabilities.length = 0;
    original.desktopObservation!.status = "active";
    original.sendAvailability!.state = "blocked";
    const snapshot = (await store.getKnownSession(NODE_ID, expected.id))!;
    expect(snapshot).toEqual(expected);

    snapshot.capabilities.push("resume-send");
    snapshot.desktopObservation!.availability = "unavailable";
    snapshot.sendAvailability!.state = "unavailable";
    expect(await store.getKnownSession(NODE_ID, expected.id)).toEqual(expected);
  });
});
