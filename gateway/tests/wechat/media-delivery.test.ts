import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { StateManager } from "../../src/runtime/state.js";
import { sendImageReply, validateImageAttachments, type ImageAttachment } from "../../src/wechat/media-delivery.js";
import { ILinkSendReceiptError } from "../../src/wechat/send-receipt.js";
import type { UploadedImageItem } from "../../src/wechat/media-upload.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image: ImageAttachment = { id: "image-1", mime: "image/png", size: png.length,
  sha256: createHash("sha256").update(png).digest("hex") };
const uploaded: UploadedImageItem = { type: 2, image_item: { mid_size: 16,
  media: { encrypt_query_param: "synthetic", aes_key: "synthetic", encrypt_type: 1 } } };

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-image-delivery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "absent-test-account.json");
  const statePath = path.join(directory, "state.json");
  const state = new StateManager(credentials, statePath);
  const options = { stateManager: state, chatId: "chat", deliveryKey: "image:delivery", images: [image],
    getImageBytes: async () => png, uploadImage: async () => uploaded, sendImage: async () => {} };
  return { options, state, reload: () => new StateManager(credentials, statePath) };
}

test("accepted images survive restart without downloading or uploading again", async t => {
  const { options, reload } = fixture(t);
  let sent = 0;
  await sendImageReply({ ...options, sendImage: async () => { sent++; } });
  await sendImageReply({ ...options, stateManager: reload(), getImageBytes: async () => { throw new Error("must not read"); } });
  assert.equal(sent, 1);
});

test("ambiguous image send persists in-flight before network and refuses replay after restart", async t => {
  const { options, state, reload } = fixture(t);
  let sent = 0;
  await assert.rejects(sendImageReply({ ...options, sendImage: async () => {
    sent++;
    assert.equal(reload().replyDeliveries[options.deliveryKey].inFlight, true);
    throw new Error("network ambiguity");
  } }), /network ambiguity/);
  assert.equal(state.replyDeliveries[options.deliveryKey].inFlight, true);
  await assert.rejects(sendImageReply({ ...options, stateManager: reload() }), /uncertain/);
  assert.equal(sent, 1);
});

test("explicit image rejection resumes with deterministic client ID but never repeats acknowledged images", async t => {
  const { options, reload } = fixture(t);
  const images = [image, { ...image, id: "image-2" }];
  const ids: string[] = [];
  await assert.rejects(sendImageReply({ ...options, images, sendImage: async (_item, id) => {
    ids.push(id);
    if (ids.length === 2) throw new ILinkSendReceiptError("RejectedRet");
  } }), /RejectedRet/);
  await sendImageReply({ ...options, images, stateManager: reload(), sendImage: async (_item, id) => { ids.push(id); } });
  assert.equal(ids.length, 3);
  assert.equal(ids[1], ids[2]);
  assert.notEqual(ids[0], ids[1]);
});

test("download and upload failures never create a pending send intent", async t => {
  const { options, state } = fixture(t);
  let sent = 0;
  await assert.rejects(sendImageReply({ ...options, uploadImage: async () => { throw new Error("upload failed"); },
    sendImage: async () => { sent++; } }), /upload failed/);
  assert.equal(state.replyDeliveries[options.deliveryKey].inFlight, false);
  await assert.rejects(sendImageReply({ ...options, getImageBytes: async () => Buffer.from("bad-image") }), /metadata|signature/);
  assert.equal(state.replyDeliveries[options.deliveryKey].inFlight, false);
  await sendImageReply({ ...options, sendImage: async () => { sent++; } });
  assert.equal(sent, 1);
});

test("persisted digest includes immutable image hash and metadata rejects unsafe descriptors", async t => {
  const { options } = fixture(t);
  await sendImageReply(options);
  await assert.rejects(sendImageReply({ ...options, images: [{ ...image, sha256: "f".repeat(64) }] }), /content or chunk plan changed/);
  for (const value of [null, [{ ...image, url: "https://example.test/image" }], [image, image],
    [{ ...image, size: 0 }], [{ ...image, mime: "image/svg+xml" }], [{ ...image, sha256: "bad" }],
    [image, { ...image, id: "2" }, { ...image, id: "3" }, { ...image, id: "4" }]]) {
    assert.throws(() => validateImageAttachments(value), /Invalid/);
  }
});

test("ignored cancellation is bounded before upload and during uncertain send", async t => {
  for (const phase of ["download", "send"]) {
    const { options, state } = fixture(t);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("synthetic deadline")), 15);
    try {
      await assert.rejects(sendImageReply({ ...options, signal: controller.signal,
        ...(phase === "download" ? { getImageBytes: async () => new Promise<Buffer>(() => {}) } :
          { sendImage: async () => new Promise<void>(() => {}) }),
      }), /synthetic deadline/);
      assert.equal(state.replyDeliveries[options.deliveryKey].inFlight, phase === "send");
    } finally { clearTimeout(timer); }
  }
});
