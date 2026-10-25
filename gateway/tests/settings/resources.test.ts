import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { disabledWorkspaceSkills, MAX_RESOURCE_BYTES, RuntimeResourceError, RuntimeResources } from "../../src/settings/resources.js";

function fixture(t: TestContext) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "runtime-resources-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "settings");
  const skillsRoot = path.join(temporary, "deployed-skills");
  fs.mkdirSync(path.join(skillsRoot, "control", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "control", "SKILL.md"), "# Control\nRead scripts/help.sh\n");
  fs.writeFileSync(path.join(skillsRoot, "control", "scripts", "help.sh"), "#!/bin/sh\necho help\n", { mode: 0o755 });
  const options = { root, skillsRoot, defaults: { main: "Main system prompt\n", memory: "Memory instructions\n" } };
  return { temporary, root, skillsRoot, options, resources: new RuntimeResources(options) };
}
function status(expected: number) {
  return (error: unknown) => error instanceof RuntimeResourceError && error.status === expected;
}

test("prompt overlay survives reconstruction, retains source default, and requires compare-and-swap", (t) => {
  const { root, options, resources } = fixture(t);
  const initial = resources.read("prompt/main");
  assert.equal(initial.source, "default");
  assert.equal(initial.version, `sha256:${initial.revision}`);
  const saved = resources.write(initial.id, { content: "Edited main prompt\n", expectedRevision: initial.revision });
  assert.equal(saved.source, "override");
  assert.notEqual(saved.revision, initial.revision);
  assert.equal(new RuntimeResources(options).read(initial.id).content, "Edited main prompt\n");
  assert.equal(options.defaults.main, "Main system prompt\n");
  assert.throws(() => resources.write(initial.id, { content: "stale", expectedRevision: initial.revision }), status(409));
  assert.throws(() => resources.write(initial.id, { content: "no revision", expectedRevision: "" }), status(400));
  assert.equal(resources.read(initial.id).content, saved.content);
  assert.equal(fs.statSync(path.join(root, "prompts", "main.md")).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(root), ["prompts"]);
});

test("skill child edits overlay deployment and freeze the complete tree including executable scripts and binary files", (t) => {
  const { temporary, skillsRoot, resources } = fixture(t);
  fs.writeFileSync(path.join(skillsRoot, "control", "icon.bin"), Buffer.from([0, 255, 5]));
  const resource = resources.read("skill/control/scripts/help.sh");
  resources.write(resource.id, { content: "#!/bin/sh\necho edited\n", expectedRevision: resource.revision });
  assert.equal(fs.readFileSync(path.join(skillsRoot, "control", "scripts", "help.sh"), "utf8"), "#!/bin/sh\necho help\n");
  const listed = resources.list();
  assert.equal(listed.find(item => item.id === "skill/control/icon.bin")?.editable, false);
  assert.equal(listed.find(item => item.id === resource.id)?.source, "override");
  assert.throws(() => resources.read("skill/control/icon.bin"), status(400));
  const frozen = path.join(temporary, "turn-1-skills");
  const snapshot = resources.snapshotSkills(frozen);
  assert.equal(snapshot.length, 3);
  const script = path.join(frozen, "control", "scripts", "help.sh");
  assert.equal(fs.readFileSync(script, "utf8"), "#!/bin/sh\necho edited\n");
  assert.equal(fs.statSync(script).mode & 0o111, 0o111);
  assert.deepEqual(fs.readFileSync(path.join(frozen, "control", "icon.bin")), Buffer.from([0, 255, 5]));
  const edited = resources.read(resource.id);
  resources.write(resource.id, { content: "new turn only", expectedRevision: edited.revision });
  assert.equal(fs.readFileSync(script, "utf8"), "#!/bin/sh\necho edited\n");
  assert.throws(() => resources.snapshotSkills(frozen), status(409));
});

test("traversal and symlinks at leaves or ancestors are rejected without modifying targets", (t) => {
  const { temporary, root, skillsRoot, resources } = fixture(t);
  for (const id of ["prompt/../main", "skill/control/../SKILL.md", "skill/control//SKILL.md", "skill/control\\SKILL.md", "/prompt/main"]) {
    assert.throws(() => resources.read(id), status(400));
  }
  fs.mkdirSync(root);
  const external = path.join(temporary, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "main.md"), "untouched");
  fs.symlinkSync(external, path.join(root, "prompts"));
  assert.throws(() => resources.read("prompt/main"), status(400));
  assert.equal(fs.readFileSync(path.join(external, "main.md"), "utf8"), "untouched");
  fs.unlinkSync(path.join(root, "prompts"));
  fs.symlinkSync(path.join(external, "main.md"), path.join(skillsRoot, "control", "escape.md"));
  assert.throws(() => resources.list(), status(400));
  assert.throws(() => resources.snapshotSkills(path.join(temporary, "frozen")), status(400));
  fs.unlinkSync(path.join(skillsRoot, "control", "escape.md"));
  const prompt = resources.read("prompt/main");
  fs.mkdirSync(path.join(root, "prompts"));
  fs.symlinkSync(path.join(external, "main.md"), path.join(root, "prompts", "main.md"));
  assert.throws(() => resources.write(prompt.id, { content: "changed", expectedRevision: prompt.revision }), status(400));
});

test("hard links, invalid UTF-8, oversized files, and overlapping snapshots fail safely", (t) => {
  const { temporary, root, skillsRoot, resources } = fixture(t);
  const original = path.join(skillsRoot, "control", "SKILL.md");
  fs.linkSync(original, path.join(temporary, "hardlink"));
  assert.throws(() => resources.read("skill/control/SKILL.md"), status(400));
  fs.unlinkSync(path.join(temporary, "hardlink"));
  const prompt = resources.read("prompt/main");
  for (const content of ["\ud800", "text\0hidden"]) {
    assert.throws(() => resources.write(prompt.id, { content, expectedRevision: prompt.revision }), status(400));
  }
  assert.throws(() => resources.write(prompt.id, { content: "x".repeat(MAX_RESOURCE_BYTES + 1), expectedRevision: prompt.revision }), status(413));
  for (const target of [root, path.join(root, "snapshot"), skillsRoot, temporary]) {
    assert.throws(() => resources.snapshotSkills(target), status(400));
  }
  fs.writeFileSync(path.join(skillsRoot, "control", "large"), Buffer.alloc(MAX_RESOURCE_BYTES + 1));
  assert.throws(() => resources.list(), status(413));
});

test("an orphaned legacy lock cannot prevent updates after Gateway restart", (t) => {
  const { root, options, resources } = fixture(t);
  const initial = resources.read("prompt/main");
  fs.mkdirSync(root);
  const lock = path.join(root, ".resource-write.lock");
  fs.writeFileSync(lock, "");
  const restarted = new RuntimeResources(options);
  const saved = restarted.write(initial.id, { content: "after restart", expectedRevision: initial.revision });
  assert.equal(saved.content, "after restart");
  assert.equal(resources.read(initial.id).revision, saved.revision);
  assert.equal(fs.readFileSync(lock, "utf8"), "");
});

test("store instances in the Gateway reject stale revisions without a disk lock", (t) => {
  const { root, options, resources } = fixture(t);
  const other = new RuntimeResources(options);
  const initial = other.read("prompt/main");
  const saved = resources.write(initial.id, { content: "first update", expectedRevision: initial.revision });
  assert.throws(() => other.write(initial.id, { content: "lost update", expectedRevision: initial.revision }),
    (error: unknown) => error instanceof RuntimeResourceError && error.code === "revision_conflict");
  assert.equal(other.read(initial.id).content, saved.content);
  assert.deepEqual(fs.readdirSync(root), ["prompts"]);
});

test("workspace skill disabling inspects nested SKILL.md without mutating it and rejects links", t => {
  const { temporary } = fixture(t);
  const workspace = path.join(temporary, "chat");
  assert.deepEqual(disabledWorkspaceSkills(workspace), []);
  const skill = path.join(workspace, ".agents", "skills", "local", "nested", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "# Existing local skill");
  assert.deepEqual(disabledWorkspaceSkills(workspace), [{ path: skill, enabled: false }]);
  assert.equal(fs.readFileSync(skill, "utf8"), "# Existing local skill");
  const link = path.join(workspace, ".agents", "skills", "escape");
  fs.symlinkSync(path.dirname(skill), link);
  assert.throws(() => disabledWorkspaceSkills(workspace), status(400));
});
