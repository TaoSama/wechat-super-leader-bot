import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
const releaseScript = readFileSync(new URL('../../../scripts/deploy/remote-release.sh', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../../../deploy/compose.release.yaml', import.meta.url), 'utf8');

test('production CD deploys one main push with protected, immutable inputs', () => {
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, /build-and-deploy:\s*\n\s+name:[\s\S]*?\n\s+if: \$\{\{ github\.ref ===? 'refs\/heads\/main' \}\}/);
  assert.match(workflow, /group: deploy-production/);
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
  assert.match(workflow, /"\$release_root\/compose\.release\.yaml" "\$release_root\/compose\.yaml"/);
  assert.match(workflow, /scp_opts=\(\-i "\$key_file" \-P "\$deploy_port"/);
  assert.match(workflow, /scp -q "\$\{scp_opts\[@\]\}"/);
  assert.doesNotMatch(workflow, /scp -q "\$\{ssh_opts\[@\]\}"/);
  assert.match(workflow, /--compose-base/);
  assert.match(workflow, /--seccomp-policy/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /UserKnownHostsFile=/);
});

test('remote release verifies before switching and keeps a bounded rollback path', () => {
  assert.match(releaseScript, /sha256sum -c/);
  assert.match(releaseScript, /linux\/amd64/);
  assert.match(releaseScript, /org\.opencontainers\.image\.revision/);
  assert.match(releaseScript, /release bundle checksum verification failed/);
  assert.match(releaseScript, /config --quiet/);
  assert.match(releaseScript, /CODEX_SECCOMP_PATH/);
  assert.match(releaseScript, /GATEWAY_CONTEXT_WINDOW_MS=86400000/);
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

test('release overlay only selects images and cannot introduce volumes', () => {
  assert.match(overlay, /controller:\s*\n\s+image: \$\{CONTROLLER_IMAGE:\?set CONTROLLER_IMAGE\}/);
  assert.match(overlay, /gateway:\s*\n\s+image: \$\{GATEWAY_IMAGE:\?set GATEWAY_IMAGE\}/);
  assert.doesNotMatch(overlay.replace(/^\s*#.*$/gm, ''), /volume|volumes|ports|privileged/);
});
