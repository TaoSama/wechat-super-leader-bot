import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const policy = JSON.parse(readFileSync(new URL('../../../deploy/security/codex-seccomp.json', import.meta.url), 'utf8'));
const apparmor = readFileSync(new URL('../../../deploy/security/codex-apparmor', import.meta.url), 'utf8');
const NEWUSER = 0x10000000;
const NEWNET = 0x40000000;
const BWRAP_CLONE = 0x38020011;

// Evaluate the production target: amd64 with every capability dropped. This
// checks effective permissions, including upstream capability-conditional rules.
function allows(name, args = []) {
  return policy.syscalls.some(rule => {
    if (rule.action !== 'SCMP_ACT_ALLOW' || !rule.names.includes(name)) return false;
    if (rule.includes?.caps?.length || rule.includes?.arches && !rule.includes.arches.includes('amd64') ||
        rule.excludes?.arches?.includes('amd64')) return false;
    return (rule.args ?? []).every(condition => {
      const actual = args[condition.index] ?? 0;
      if (condition.op === 'SCMP_CMP_EQ') return actual === condition.value;
      if (condition.op === 'SCMP_CMP_MASKED_EQ') return (actual & condition.value) === (condition.valueTwo ?? 0);
      throw new Error(`Unsupported seccomp condition: ${condition.op}`);
    });
  });
}

test('Codex can create only the required namespace shape and detach its own old root', () => {
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  for (const name of ['read', 'write', 'execve', 'mount', 'pivot_root']) assert.equal(allows(name), true, name);
  assert.equal(allows('clone', [BWRAP_CLONE]), true);
  assert.equal(allows('unshare', [NEWUSER]), true);
  assert.equal(allows('umount2', [0, 2]), true);
  for (const flags of [BWRAP_CLONE | NEWNET, BWRAP_CLONE & ~NEWUSER, NEWNET, NEWUSER]) {
    assert.equal(allows('clone', [flags]), false, `clone flags ${flags}`);
  }
  for (const flags of [NEWNET, NEWUSER | NEWNET, 0]) assert.equal(allows('unshare', [flags]), false);
  for (const flags of [0, 1, 8]) assert.equal(allows('umount2', [0, flags]), false);
});

test('the container retains Docker restrictions outside the namespace setup path', () => {
  for (const name of ['clone3', 'setns', 'chroot', 'sethostname', 'fsopen', 'mount_setattr',
    'bpf', 'reboot', 'kexec_load', 'init_module', 'open_by_handle_at', 'keyctl']) {
    assert.equal(allows(name), false, name);
  }
  assert.ok(policy.syscalls.some(rule => rule.names.includes('clone3') &&
    rule.action === 'SCMP_ACT_ERRNO' && rule.errnoRet === 38), 'retain clone3 fallback to clone');
  assert.match(apparmor, /profile super-leader-codex flags=\(attach_disconnected,mediate_deleted\)/);
  assert.match(apparmor, /^  mount,$/m);
  assert.match(apparmor, /^  pivot_root,$/m);
  assert.doesNotMatch(apparmor, /flags=\([^)]*(?:complain|unconfined)/);
  for (const resource of ['@{PROC}/sysrq-trigger', '@{PROC}/kcore', '/sys/kernel/security/**']) {
    assert.ok(apparmor.includes(`deny ${resource} rwklx,`), resource);
  }
  assert.match(apparmor, /ptrace \(trace,tracedby,read,readby\) peer=super-leader-codex,/);
});
