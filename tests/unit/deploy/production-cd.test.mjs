import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
const releaseScript = readFileSync(new URL('../../../scripts/deploy/remote-release.sh', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../../../deploy/compose.release.yaml', import.meta.url), 'utf8');
const transfer = readFileSync(new URL('../../../scripts/deploy/transfer-release.mjs', import.meta.url), 'utf8');
const files = readFileSync(new URL('../../../scripts/deploy/transfer-files.mjs', import.meta.url), 'utf8');

test('production CD gates Verify completions before deploying immutable merged revisions', () => {
  assert.match(workflow, /workflow_run:\s*\n\s*workflows: \[Verify\]\s*\n\s*types: \[completed\]/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'pull_request'/);
  assert.match(workflow, /ref: refs\/heads\/main/);
  assert.match(workflow, /needs: resolve/);
  assert.match(workflow, /REVISION: \$\{\{ needs\.resolve\.outputs\.revision \}\}/);
  assert.match(workflow, /ref: \$\{\{ env\.REVISION \}\}/);
  const production = workflow.split('\n  diagnostic-only:')[0];
  assert.equal((production.match(/--assert-current "\$REVISION"/g) ?? []).length, 2);
  assert.match(transfer, /'--assert-current', config.revision/);
  assert.doesNotMatch(workflow, /ref:.*workflow_run\.head_sha/);
  assert.doesNotMatch(workflow, /download-artifact/);
  assert.match(workflow, /pull_request_target:\s*\n\s*types: \[closed\]/);
  assert.doesNotMatch(workflow, /push:\s*\n/);
  assert.doesNotMatch(workflow, /pull_request:\s*\n/);
  assert.match(workflow, /group: deploy-production\s*\n\s*queue: max\s*\n\s*cancel-in-progress: false/);
  assert.match(workflow, /environment:\s*\n\s+name: production/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /--platform linux\/amd64/);
  assert.match(workflow, /--build-arg VCS_REF="\$REVISION"/);
  assert.match(workflow, /--cache-from "type=gha,scope=\$component"/);
  assert.match(workflow, /--cache-to "type=gha,scope=\$component,mode=max"/);
  assert.match(workflow, /--output "type=docker,dest=\$archive"/);
  assert.match(workflow, /build_image controller[\s\S]*&[\s\S]*build_image gateway[\s\S]*&/);
  assert.match(workflow, /sha256sum controller\.tar gateway\.tar/);
  assert.match(workflow, /compose\.yaml compose\.release\.yaml compose\.production\.yaml compose\.gateway\.yaml codex-seccomp\.json/);
  assert.match(workflow, /cp scripts\/deploy\/remote-release\.sh "\$release_root\/remote-release\.sh"/);
  assert.match(workflow, /node scripts\/deploy\/transfer-release.mjs --release-root/);
  assert.match(files, /'compose.release.yaml', 'compose.yaml', 'compose.production.yaml', 'compose.gateway.yaml'/);
  assert.match(transfer, /--compose-base/);
  assert.match(transfer, /--seccomp-policy/);
  assert.match(transfer, /StrictHostKeyChecking=yes/);
  assert.match(transfer, /UserKnownHostsFile=/);
  assert.doesNotMatch(transfer, /\['-q'/);
});

test('diagnostic-only is manual trusted-main, mutually exclusive with deploy, and creates no deployment record', () => {
  assert.match(workflow, /workflow_dispatch:[\s\S]*diagnostic_only:[\s\S]*type: boolean[\s\S]*default: false/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main' && !inputs.diagnostic_only/);
  const diagnostic = workflow.split('\n  diagnostic-only:')[1];
  assert.match(diagnostic, /github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main' && inputs.diagnostic_only/);
  assert.match(diagnostic, /environment:\s*\n\s+name: production\s*\n\s+deployment: false/);
  assert.match(diagnostic, /ref: refs\/heads\/main/);
  assert.match(diagnostic, /transfer-release.mjs --diagnostic/);
  assert.doesNotMatch(diagnostic, /docker load|docker compose|remote-release.sh|--release-root/);
  assert.match(diagnostic, /does not establish a deployed runtime revision/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /failure\(\) \|\| cancelled\(\)/);
});

test('remote release verifies before switching and keeps a bounded rollback path', () => {
  assert.match(releaseScript, /sha256sum -c/);
  assert.match(releaseScript, /linux\/amd64/);
  assert.match(releaseScript, /org\.opencontainers\.image\.revision/);
  assert.match(releaseScript, /release bundle checksum verification failed/);
  assert.match(releaseScript, /config --quiet/);
  assert.match(releaseScript, /CODEX_SECCOMP_PATH/);
  assert.match(releaseScript, /GATEWAY_CONTEXT_WINDOW_MS=82800000/);
  assert.match(releaseScript, /compose_base/);
  assert.match(releaseScript, /-u COMPOSE_FILE -u COMPOSE_PROFILES -u COMPOSE_ENV_FILES/);
  assert.match(releaseScript, /up -d --no-build --force-recreate controller gateway/);
  assert.match(releaseScript, /wait_healthy controller/);
  assert.match(releaseScript, /wait_healthy gateway/);
  assert.match(releaseScript, /docker inspect --format '[^']*Config\.Env/);
  assert.ok(releaseScript.includes("sed -n 's/^GATEWAY_CONTEXT_WINDOW_MS=//p'"));
  assert.match(releaseScript, /restoring the previous image selection/);
  assert.match(releaseScript, /pruned \$removed superseded release image tag/);
  assert.doesNotMatch(releaseScript, /docker image prune/);
  assert.doesNotMatch(releaseScript, /compose.*\bdown\b/);
});

test('release overlay selects same-stack images and transport without introducing volumes', () => {
  assert.match(overlay, /controller:\s*\n\s+image: \$\{CONTROLLER_IMAGE:\?set CONTROLLER_IMAGE\}/);
  assert.match(overlay, /gateway:\s*\n\s+image: \$\{GATEWAY_IMAGE:\?set GATEWAY_IMAGE\}/);
  assert.doesNotMatch(overlay.replace(/^\s*#.*$/gm, ''), /volume|volumes|ports|privileged/);
});
