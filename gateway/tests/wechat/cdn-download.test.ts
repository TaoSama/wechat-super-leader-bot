import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import {
  MAX_INBOUND_FILE_BYTES, MAX_INBOUND_IMAGE_BYTES, MediaDownloadError, decryptAes128Ecb, downloadInboundMedia, mediaDownloadUrl, safeFileName,
} from "../../src/wechat/cdn-download.js";
import { normalizeAesKey, parseInboundContent } from "../../src/wechat/inbound-content.js";

// FIPS-197 / SP 800-38A AES-128 ECB vector (first block).
const NIST_KEY = "2b7e151628aed2a6abf7158809cf4f3c";
const NIST_PLAIN = Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex");
const NIST_CIPHER = "3ad77bb40d7a3660a89ecaf32466ef97";
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture-image")]);

const encrypt = (plain: Buffer, keyHex: string) => {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
};
const respond = (body: Buffer, headers: Record<string, string> = {}) => async () =>
  new Response(new Uint8Array(body), { status: 200, headers });

test("AES-128-ECB decryption matches the published vector with PKCS7 padding", () => {
  const ciphertext = encrypt(NIST_PLAIN, NIST_KEY);
  assert.equal(ciphertext.subarray(0, 16).toString("hex"), NIST_CIPHER);
  assert.deepEqual(decryptAes128Ecb(ciphertext, NIST_KEY), NIST_PLAIN);
  assert.throws(() => decryptAes128Ecb(ciphertext.subarray(0, 20), NIST_KEY), MediaDownloadError);
  assert.throws(() => decryptAes128Ecb(ciphertext, "00".repeat(16)), MediaDownloadError, "wrong key fails padding");
});

test("AES keys accept image hex, base64 raw bytes and base64 hex text", () => {
  assert.equal(normalizeAesKey(NIST_KEY.toUpperCase(), undefined), NIST_KEY);
  assert.equal(normalizeAesKey(undefined, Buffer.from(NIST_KEY, "hex").toString("base64")), NIST_KEY);
  assert.equal(normalizeAesKey(undefined, Buffer.from(NIST_KEY).toString("base64")), NIST_KEY);
  assert.equal(normalizeAesKey("zz", undefined), null);
  assert.equal(normalizeAesKey(undefined, Buffer.from("short").toString("base64")), null);
  assert.equal(normalizeAesKey(undefined, undefined), undefined);
});

test("image and file items become bounded CDN references", () => {
  const content = parseInboundContent([
    { type: 2, image_item: { aeskey: NIST_KEY, media: { encrypt_query_param: "img-param" } } },
    { type: 4, file_item: { file_name: "报告.pdf", media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1",
      aes_key: Buffer.from(NIST_KEY).toString("base64") } } },
    { type: 1, text_item: { text: "帮我看看" } },
  ]);
  assert.deepEqual(content?.media, [
    { kind: "image", encryptQueryParam: "img-param", aesKeyHex: NIST_KEY },
    { kind: "file", fullUrl: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1", aesKeyHex: NIST_KEY, fileName: "报告.pdf" },
  ]);
  assert.equal(content?.text, "帮我看看");
  const alone = parseInboundContent([{ type: 2, image_item: { media: { encrypt_query_param: "p" } } }]);
  assert.deepEqual(alone, { text: "", ownText: "", media: [{ kind: "image", encryptQueryParam: "p" }] });
  assert.deepEqual(parseInboundContent([{ type: 4, file_item: { media: { encrypt_query_param: "p" } } }])?.unsupportedKinds, ["file"],
    "an unencrypted file reference is not trusted");
  assert.deepEqual(parseInboundContent([{ type: 5, video_item: { media: { encrypt_query_param: "p" } } }])?.unsupportedKinds, ["video"]);
});

test("download URLs stay on the WeChat CDN", () => {
  assert.equal(mediaDownloadUrl({ encryptQueryParam: "a b" }), "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a+b");
  assert.equal(mediaDownloadUrl({ fullUrl: "https://evil.example/x", encryptQueryParam: "p" }),
    "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=p");
  assert.throws(() => mediaDownloadUrl({ fullUrl: "http://novac2c.cdn.weixin.qq.com/x" }), MediaDownloadError);
});

test("an encrypted image downloads, decrypts and is sniffed with its hash", async () => {
  const urls: string[] = [];
  const media = await downloadInboundMedia({ kind: "image", encryptQueryParam: "p", aesKeyHex: NIST_KEY },
    { fetchImpl: async url => { urls.push(String(url)); return new Response(new Uint8Array(encrypt(PNG, NIST_KEY))); } });
  assert.equal(urls.length, 1);
  assert.deepEqual(media.bytes, PNG);
  assert.equal(media.mime, "image/png");
  assert.equal(media.name, "image.png");
  assert.equal(media.sha256, createHash("sha256").update(PNG).digest("hex"));
});

test("files keep a safe display name and extension MIME", async () => {
  const media = await downloadInboundMedia({ kind: "file", encryptQueryParam: "p", aesKeyHex: NIST_KEY, fileName: "../../etc/notes.md" },
    { fetchImpl: respond(encrypt(Buffer.from("# notes"), NIST_KEY)) });
  assert.equal(media.name, "notes.md");
  assert.equal(media.mime, "text/markdown");
  assert.equal(safeFileName("..", "attachment"), "attachment");
});

test("size caps reject declared and streamed oversize bodies", async () => {
  await assert.rejects(downloadInboundMedia({ kind: "image", encryptQueryParam: "p" },
    { fetchImpl: respond(PNG, { "content-length": String(MAX_INBOUND_IMAGE_BYTES + 1) }) }), /size limit/);
  await assert.rejects(downloadInboundMedia({ kind: "image", encryptQueryParam: "p" },
    { fetchImpl: respond(Buffer.alloc(MAX_INBOUND_IMAGE_BYTES + 1, 1)) }), /size limit/);
  await assert.rejects(downloadInboundMedia({ kind: "file", encryptQueryParam: "p", aesKeyHex: NIST_KEY },
    { fetchImpl: respond(Buffer.alloc(MAX_INBOUND_FILE_BYTES + 32, 1)) }), /size limit/);
});

test("non-image bytes, HTTP errors and network failures are download errors", async () => {
  await assert.rejects(downloadInboundMedia({ kind: "image", encryptQueryParam: "p" }, { fetchImpl: respond(Buffer.from("<html>")) }), /unsupported format/);
  await assert.rejects(downloadInboundMedia({ kind: "image", encryptQueryParam: "p" },
    { fetchImpl: async () => new Response("no", { status: 404 }) }), /HTTP 404/);
  await assert.rejects(downloadInboundMedia({ kind: "image", encryptQueryParam: "p" },
    { fetchImpl: async () => { throw new TypeError("fetch failed"); } }), MediaDownloadError);
});
