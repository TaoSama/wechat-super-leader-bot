import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { ImageUploader, MAX_IMAGE_BYTES, validateImageBytes } from "../../src/wechat/media-upload.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 6, 7]);
const cdn = "https://novac2c.cdn.weixin.qq.com/c2c/upload";

test("image upload encrypts captured Buffer and constructs the exact protocol fields", async () => {
  let authorization!: Record<string, unknown>;
  let ciphertext!: Buffer;
  const uploader = new ImageUploader({
    request: async (endpoint, payload) => {
      assert.equal(endpoint, "ilink/bot/getuploadurl");
      authorization = payload;
      return { ret: 0, upload_param: "upload+/=" };
    },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(`${url.origin}${url.pathname}`, cdn);
      assert.equal(url.searchParams.get("encrypted_query_param"), "upload+/=");
      assert.equal(url.searchParams.get("filekey"), authorization.filekey);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, { "Content-Type": "application/octet-stream" });
      ciphertext = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-param" } });
    },
  });
  const bytes = Buffer.from(png);
  const pending = uploader.upload("chat", bytes);
  bytes.fill(0);
  const item = await pending;
  assert.deepEqual(Object.keys(authorization).sort(), ["aeskey", "filekey", "filesize", "media_type", "no_need_thumb", "rawfilemd5", "rawsize", "to_user_id"].sort());
  assert.match(String(authorization.filekey), /^[a-f0-9]{32}$/);
  assert.match(String(authorization.aeskey), /^[a-f0-9]{32}$/);
  assert.equal(authorization.rawsize, png.length);
  assert.equal(authorization.filesize, 32, "PKCS7 adds a full block at an exact block boundary");
  assert.equal(authorization.rawfilemd5, createHash("md5").update(png).digest("hex"));
  assert.equal(authorization.media_type, 1);
  assert.equal(authorization.to_user_id, "chat");
  assert.equal(authorization.no_need_thumb, true);
  assert.equal(item.type, 2);
  assert.equal(item.image_item.mid_size, ciphertext.length);
  assert.equal(item.image_item.media.encrypt_query_param, "download-param");
  assert.equal(Buffer.from(item.image_item.media.aes_key, "base64").toString(), authorization.aeskey);
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(String(authorization.aeskey), "hex"), null);
  assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), png);
});

test("full upload URL takes precedence and arbitrary destinations are rejected before fetch", async () => {
  const unsafe = ["http://novac2c.cdn.weixin.qq.com/c2c/upload", "https://evil.test/c2c/upload",
    "https://novac2c.cdn.weixin.qq.com.evil.test/c2c/upload", "https://user:secret@novac2c.cdn.weixin.qq.com/c2c/upload",
    `${cdn}/other`, `${cdn}#secret`, "https://novac2c.cdn.weixin.qq.com:444/c2c/upload"];
  for (const url of unsafe) {
    let fetched = false;
    const uploader = new ImageUploader({ request: async () => ({ upload_full_url: url, upload_param: "fallback" }),
      fetchImpl: async () => { fetched = true; throw new Error("unexpected"); } });
    await assert.rejects(uploader.upload("chat", png), /URL is not allowed/);
    assert.equal(fetched, false);
  }
  const fullUrl = `${cdn}?exact=from-server`;
  const uploader = new ImageUploader({ request: async () => ({ upload_full_url: fullUrl, upload_param: "unused" }),
    fetchImpl: async input => {
      assert.equal(String(input), fullUrl);
      return new Response(null, { headers: { "x-encrypted-param": "download" } });
    } });
  await uploader.upload("chat", png);
});

test("upload validates all supported signatures and caps bytes before any network call", async () => {
  assert.equal(validateImageBytes(png), "image/png");
  assert.equal(validateImageBytes(Buffer.from([255, 216, 255])), "image/jpeg");
  assert.equal(validateImageBytes(Buffer.from("GIF89a")), "image/gif");
  assert.equal(validateImageBytes(Buffer.from("RIFF0000WEBP")), "image/webp");
  let requested = false;
  const uploader = new ImageUploader({ request: async () => { requested = true; return {}; } });
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_IMAGE_BYTES + 1), Buffer.from("<svg>bad</svg>")]) {
    await assert.rejects(uploader.upload("chat", bytes));
  }
  assert.equal(requested, false);
});

test("server failures retry only upload and require HTTP 200 with a download header", async () => {
  let attempts = 0;
  let grants = 0;
  const uploader = new ImageUploader({ request: async () => { grants++; return { upload_param: "grant" }; },
    fetchImpl: async () => {
      attempts++;
      return attempts === 1 ? new Response(null, { status: 503 }) : attempts === 2 ? new Response(null) :
        new Response(null, { headers: { "x-encrypted-param": "accepted" } });
    } });
  await uploader.upload("chat", png);
  assert.equal(grants, 1);
  assert.equal(attempts, 3);
  for (const status of [201, 302, 400, 403]) {
    let count = 0;
    const rejected = new ImageUploader({ request: async () => ({ upload_param: "grant" }),
      fetchImpl: async () => { count++; return new Response(null, { status }); } });
    await assert.rejects(rejected.upload("chat", png), new RegExp(`HTTP ${status}`));
    assert.equal(count, 1);
  }
});

test("upload deadline bounds dependencies that ignore AbortSignal without leaking request errors", async () => {
  for (const phase of ["authorization", "upload"]) {
    let signal: AbortSignal | undefined;
    const uploader = new ImageUploader({ timeoutMs: 15,
      request: async (_endpoint, _payload, _timeout, inputSignal) => {
        signal = inputSignal;
        return phase === "authorization" ? new Promise(() => {}) : { upload_param: "grant" };
      }, fetchImpl: async () => new Promise(() => {}),
    });
    const started = Date.now();
    await assert.rejects(uploader.upload("chat", png), /timed out/);
    assert.ok(Date.now() - started < 1000);
    assert.equal(signal?.aborted, true);
  }
  const uploader = new ImageUploader({ request: async () => ({ upload_param: "secret-grant" }),
    fetchImpl: async () => { throw new Error("https://example.test/private?secret-grant"); } });
  await assert.rejects(uploader.upload("chat", png), error => error instanceof Error &&
    error.message === "WeChat CDN upload request failed");
});
