import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const autoMergeWorkflow = readFileSync(new URL('../../../.github/workflows/enable-auto-merge.yml', import.meta.url), 'utf8');
const verifyWorkflow = readFileSync(new URL('../../../.github/workflows/verify.yml', import.meta.url), 'utf8');

test('auto merge is restricted to owner PRs in the repository and uses squash merge', () => {
  assert.match(autoMergeWorkflow, /pull_request_target:/);
  assert.match(autoMergeWorkflow, /contents: write/);
  assert.match(autoMergeWorkflow, /pull-requests: write/);
  assert.match(autoMergeWorkflow, /head\.repo\.full_name == github\.repository/);
  assert.match(autoMergeWorkflow, /user\.login == github\.repository_owner/);
  assert.match(autoMergeWorkflow, /pull_request\.draft == false/);
  assert.match(autoMergeWorkflow, /gh pr merge "\$PR_NUMBER" --repo "\$REPOSITORY" --auto --squash/);
  assert.doesNotMatch(autoMergeWorkflow, /actions\/checkout/);
});

test('Verify uses the supported macOS 15 runner label', () => {
  assert.doesNotMatch(verifyWorkflow, /macos-14/);
  assert.equal((verifyWorkflow.match(/os: macos-15/g) ?? []).length, 2);
  assert.match(verifyWorkflow, /matrix\.os == 'macos-15'/);
});
