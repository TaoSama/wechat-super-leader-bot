import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Input, ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { claimInboundImages, prepareInboundImageDirectory, releaseInboundImages, stageInboundImages, INBOUND_IMAGE_DIRECTORY, INBOUND_IMAGE_WINDOW_MS,
  MAX_TURN_IMAGES, type InboundImage } from "../../src/leader/inbound-images.js";
import { directToolController } from "./direct-tool-fixture.js";

const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(label: string): InboundImage {
  const bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from(label)]);
  return { mime: "image/png", bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function root(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "inbound-images-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("staged images are offered once, re-offered only to the same message and expire with the reference window", async t => {
  const workspace = await new WorkspaceStore(root(t)).forChat("account", "chat");
  const now = Date.now();
  assert.equal(stageInboundImages(workspace, "img-1", [png("a"), png("b")], now), 2);
  assert.equal(stageInboundImages(workspace, "img-1", [png("a"), png("b")], now), 0, "redelivery must not duplicate images");
  const first = claimInboundImages(workspace, "text-1", now);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map(file => fs.readFileSync(file)), [png("a").bytes, png("b").bytes]);
  assert(first.every(file => path.dirname(file) === path.join(workspace.workspacePath, INBOUND_IMAGE_DIRECTORY)));
  assert.deepEqual(claimInboundImages(workspace, "text-1", now), first, "a retry of the same turn sees the same pixels");
  assert.deepEqual(claimInboundImages(workspace, "text-2", now), [], "another turn must not see them again");

  releaseInboundImages(workspace, "text-1", now);
  assert.deepEqual(claimInboundImages(workspace, "text-3", now), first, "a provably failed turn returns its images");

  stageInboundImages(workspace, "img-old", [png("old")], now - INBOUND_IMAGE_WINDOW_MS - 1);
  assert.deepEqual(claimInboundImages(workspace, "text-4", now), [], "images older than the window are not attached");
});

test("a turn attaches at most the newest images and skips files that no longer match their hash", async t => {
  const workspace = await new WorkspaceStore(root(t)).forChat("account", "chat");
  const now = Date.now();
  const images = Array.from({ length: MAX_TURN_IMAGES + 2 }, (_, index) => png(`image-${index}`));
  for (const [index, image] of images.entries()) stageInboundImages(workspace, `img-${index}`, [image], now + index);
  const tampered = path.join(workspace.workspacePath, INBOUND_IMAGE_DIRECTORY, `${images.at(-1)!.sha256}.png`);
  fs.writeFileSync(tampered, Buffer.concat([PNG_SIGNATURE, Buffer.from("swapped")]));
  const claimed = claimInboundImages(workspace, "text", now + images.length);
  assert.equal(claimed.length, MAX_TURN_IMAGES);
  assert(!claimed.includes(tampered));
  assert.deepEqual(claimed.map(file => fs.readFileSync(file)), images.slice(1, -1).map(image => image.bytes));
  assert.throws(() => stageInboundImages(workspace, "bad", [{ ...png("x"), mime: "image/jpeg" }], now), /Inbound image content is invalid/);
});

test("the main chat turn receives staged images as local image input, and only once", async t => {
  const directory = root(t);
  const inputs: Input[] = [];
  const engine = new CodexReplyEngine({ root: directory, model: "test", codexPath: process.execPath,
    sdkFactory: () => {
      const thread = { runStreamed: async (input: Input) => {
        inputs.push(input);
        return { events: (async function* (): AsyncIterable<ThreadEvent> {
          yield { type: "item.completed", item: { type: "agent_message", id: "a", text: "图里是一只猫" } };
          yield { type: "turn.completed", usage };
        })() };
      } };
      return { startThread: () => thread, resumeThread: () => thread };
    } });
  t.after(() => engine.stop());
  const controller = directToolController();
  await engine.stageImages("account", "chat", "img", [png("cat")]);
  assert.deepEqual(await engine.reply("account", { chatId: "chat", messageId: "ask", text: "图里是什么？" }, controller), { text: "图里是一只猫" });
  await engine.reply("account", { chatId: "chat", messageId: "next", text: "谢谢" }, controller);

  const [first, second] = inputs;
  assert(Array.isArray(first), "an image turn must use structured input");
  assert.equal(first[0].type, "text");
  assert.match(first[0].type === "text" ? first[0].text : "", /<current_user_images count="1">/);
  const image = first[1];
  assert.equal(image?.type, "local_image");
  assert.deepEqual(fs.readFileSync(image.type === "local_image" ? image.path : ""), png("cat").bytes);
  assert.equal(typeof second, "string", "the next turn must not resend the same image");
  assert.doesNotMatch(String(second), /current_user_images/);
});

test("an empty sandbox placeholder at the staging path is replaced by the directory; other files are refused", async t => {
  const workspace = await new WorkspaceStore(root(t)).forChat("account", "chat");
  const target = path.join(workspace.workspacePath, INBOUND_IMAGE_DIRECTORY);
  fs.writeFileSync(target, "", { mode: 0o444 });
  prepareInboundImageDirectory(workspace);
  assert.ok(fs.lstatSync(target).isDirectory());
  assert.equal(stageInboundImages(workspace, "m1", [png("after-repair")], Date.now()), 1);
  fs.rmSync(target, { recursive: true });
  fs.writeFileSync(target, "not a placeholder");
  assert.throws(() => prepareInboundImageDirectory(workspace));
  assert.equal(fs.readFileSync(target, "utf8"), "not a placeholder");
});
