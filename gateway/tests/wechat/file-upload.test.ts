import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { FileUploader, type FileUploadMetadata } from "../../src/wechat/file-upload.js";

const bytes = Buffer.from("# 研究成果\n\n完整正文和附件数据\n", "utf8");
function metadata(input = bytes): FileUploadMetadata {
  return { fileName: "研究成果.md", byteLength: input.length,
    sha256: createHash("sha256").update(input).digest("hex") };
}

test("file upload uses FILE authorization, exact AES bytes and plaintext string length", async () => {
  let authorization!: Record<string, unknown>;
  let ciphertext!: Buffer;
  const uploader = new FileUploader({
    request: async (endpoint, payload) => {
      assert.equal(endpoint, "ilink/bot/getuploadurl", "upload never submits a chat message");
      authorization = payload;
      return { ret: 0, upload_param: "upload+/=" };
    },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://novac2c.cdn.weixin.qq.com");
      assert.equal(url.searchParams.get("encrypted_query_param"), "upload+/=");
      assert.equal(url.searchParams.get("filekey"), authorization.filekey);
      assert.equal(init?.redirect, "error");
      ciphertext = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { headers: { "x-encrypted-param": "download" } });
    },
  });
  const mutableBytes = Buffer.from(bytes);
  const mutableMetadata = metadata();
  const pending = uploader.upload("chat", mutableBytes, mutableMetadata);
  mutableBytes.fill(0);
  mutableMetadata.fileName = "changed.md";
  const item = await pending;
  assert.equal(authorization.media_type, 3);
  assert.equal(authorization.rawsize, bytes.length);
  assert.equal(authorization.rawfilemd5, createHash("md5").update(bytes).digest("hex"));
  assert.equal(authorization.filesize, ciphertext.length);
  assert.equal(authorization.no_need_thumb, true);
  assert.deepEqual(item, { type: 4, file_item: {
    media: { encrypt_query_param: "download", encrypt_type: 1,
      aes_key: Buffer.from(String(authorization.aeskey)).toString("base64") },
    file_name: "研究成果.md", len: String(bytes.length),
  } });
  const key = Buffer.from(Buffer.from(item.file_item.media.aes_key, "base64").toString(), "hex");
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), bytes);
});

test("integrity and local size checks reject before authorizing any upload", async () => {
  let networkCalls = 0;
  const uploader = new FileUploader({ maxFileBytes: bytes.length,
    request: async () => { networkCalls++; return {}; } });
  const invalid = [
    { input: Buffer.alloc(0), meta: metadata(Buffer.alloc(0)) },
    { input: Buffer.concat([bytes, Buffer.from("x")]), meta: metadata() },
    { input: bytes, meta: { ...metadata(), byteLength: bytes.length - 1 } },
    { input: bytes, meta: { ...metadata(), byteLength: "1" as unknown as number } },
    { input: bytes, meta: { ...metadata(), sha256: "0".repeat(64) } },
    { input: bytes, meta: { ...metadata(), sha256: "not-a-digest" } },
  ];
  for (const { input, meta } of invalid) await assert.rejects(uploader.upload("chat", input, meta));
  for (const fileName of ["", " ", ".", "..", "../report.md", "report\\data.md", "bad\nname.md",
    "bad\u0000name.md", "文".repeat(86)]) {
    await assert.rejects(uploader.upload("chat", bytes, { ...metadata(), fileName }), /valid file name/);
  }
  assert.equal(networkCalls, 0);
});

test("local product limit is configurable and inclusive", async () => {
  const uploader = new FileUploader({ maxFileBytes: bytes.length,
    request: async () => ({ upload_param: "grant" }),
    fetchImpl: async () => new Response(null, { headers: { "x-encrypted-param": "download" } }),
  });
  assert.equal((await uploader.upload("chat", bytes, metadata())).file_item.len, String(bytes.length));
  const longer = Buffer.concat([bytes, Buffer.from("x")]);
  await assert.rejects(uploader.upload("chat", longer, metadata(longer)), /configured byte limit/);
  for (const maxFileBytes of [0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new FileUploader({ maxFileBytes, request: async () => ({}) }), /byte limit/);
  }
});

test("upload-only retries preserve ciphertext, do not reauthorize and never send a message", async () => {
  let grants = 0;
  const encryptedBodies: Buffer[] = [];
  const bodyViews: Uint8Array[] = [];
  const uploader = new FileUploader({
    request: async (endpoint) => {
      assert.equal(endpoint, "ilink/bot/getuploadurl");
      grants++;
      return { upload_param: "grant" };
    },
    fetchImpl: async (_input, init) => {
      bodyViews.push(init?.body as Uint8Array);
      encryptedBodies.push(Buffer.from(init?.body as Uint8Array));
      return encryptedBodies.length === 1 ? new Response(null, { status: 503 }) :
        new Response(null, { headers: { "x-encrypted-param": "download" } });
    },
  });
  await uploader.upload("chat", bytes, metadata());
  assert.equal(grants, 1);
  assert.equal(encryptedBodies.length, 2);
  assert.deepEqual(encryptedBodies[0], encryptedBodies[1]);
  assert.equal(bodyViews[0].buffer, bodyViews[1].buffer, "retries reuse the encrypted backing store");
});

test("authorization rejection and untrusted CDN targets never upload", async () => {
  for (const grant of [{ ret: -2, upload_param: "grant" }, { errcode: 3, upload_param: "grant" },
    { upload_full_url: "https://attacker.test/c2c/upload", upload_param: "unused" }, {}]) {
    let fetched = false;
    const uploader = new FileUploader({ request: async () => grant,
      fetchImpl: async () => { fetched = true; throw new Error("unexpected"); } });
    await assert.rejects(uploader.upload("chat", bytes, metadata()));
    assert.equal(fetched, false);
  }
});

test("cancelled or timed out uploads finish without sending messages", async () => {
  const signal = AbortSignal.abort(new Error("cancelled"));
  let networkCalls = 0;
  const cancelled = new FileUploader({ request: async () => { networkCalls++; return {}; } });
  await assert.rejects(cancelled.upload("chat", bytes, metadata(), signal), /cancelled/);
  assert.equal(networkCalls, 0);
  for (const phase of ["authorization", "upload"]) {
    const uploader = new FileUploader({ timeoutMs: 15,
      request: async () => phase === "authorization" ? new Promise(() => {}) : { upload_param: "grant" },
      fetchImpl: async () => new Promise(() => {}),
    });
    await assert.rejects(uploader.upload("chat", bytes, metadata()), /file upload timed out/);
  }
});

test("file transfer receives a size allowance while upload authorization stays bounded", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const content = Buffer.alloc(1024 * 1024), abort = new AbortController();
  let grantTimeout = 0, transferSignal: AbortSignal | undefined;
  const uploader = new FileUploader({
    request: async (_endpoint, _payload, timeoutMs) => { grantTimeout = timeoutMs; return { upload_param: "grant" }; },
    fetchImpl: async (_input, init) => {
      transferSignal = init!.signal! as AbortSignal;
      return new Promise<Response>(() => {});
    },
  });
  const pending = assert.rejects(uploader.upload("chat", content, metadata(content), abort.signal), /file upload timed out/);
  // Authorization awaits before the upload starts; no real elapsed time or large allocation is needed.
  for (let count = 0; count < 8 && !transferSignal; count++) await Promise.resolve();
  assert.ok(transferSignal);
  assert.equal(grantTimeout, 30_000);
  t.mock.timers.tick(30_000);
  assert.equal(transferSignal.aborted, false);
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(transferSignal.aborted, true);
});

test("authorization cannot inherit the longer file transfer deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const content = Buffer.alloc(1024 * 1024);
  const uploader = new FileUploader({ request: async () => new Promise(() => {}) });
  const pending = assert.rejects(uploader.upload("chat", content, metadata(content)), /upload authorization timed out/);
  t.mock.timers.tick(30_000);
  await pending;
});

test("parent cancellation interrupts an extended file transfer before any send", async () => {
  const abort = new AbortController();
  const uploader = new FileUploader({ request: async () => ({ upload_param: "grant" }),
    fetchImpl: async () => { abort.abort(new Error("parent-stop")); return new Promise(() => {}); } });
  await assert.rejects(uploader.upload("chat", bytes, metadata(), abort.signal), /parent-stop/);
});
