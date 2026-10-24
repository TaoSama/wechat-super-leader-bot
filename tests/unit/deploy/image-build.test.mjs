import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const BASE_IMAGE = 'node:24-bookworm-slim';
const NATIVE_TOOLCHAIN = `FROM --platform=$BUILDPLATFORM ${BASE_IMAGE} AS toolchain`;
const CONTROLLER_RUNTIME_INSTALL = 'RUN npm install --global @openai/codex@0.163.0 && mkdir -p /var/lib/super-leader-background /var/lib/super-leader-artifacts && chown node:node /var/lib/super-leader-background /var/lib/super-leader-artifacts';
const SKILL_RUNTIME_INSTALL = 'RUN apt-get update && apt-get install -y --no-install-recommends python3 curl python3-bs4 python3-html2text && rm -rf /var/lib/apt/lists/*';
const SKILL_RUNTIME_PERMISSIONS = 'RUN chmod -R go-w /etc/codex/skills';
const controllerDockerfile = readFileSync(new URL('../../../deploy/Dockerfile.controller', import.meta.url), 'utf8');
const gatewayDockerfile = readFileSync(new URL('../../../deploy/Dockerfile.gateway', import.meta.url), 'utf8');

function stages(source) {
  const result = [];
  for (const line of source.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const instruction = line.trim();
    if (!instruction || instruction.startsWith('#')) continue;
    if (/^FROM\s/i.test(instruction)) result.push([instruction]);
    else {
      assert.ok(result.length, 'instruction must follow FROM');
      result.at(-1).push(instruction);
    }
  }
  return result;
}

function assertImageContract(source, component) {
  const parsed = stages(source);
  const buildNames = component === 'controller' ? ['controller-build', 'web-build'] : ['build', 'runtime-dependencies', 'runtime-certificates'];
  assert.equal(parsed.length, buildNames.length + (component === 'controller' ? 3 : 2));
  assert.equal(parsed[0][0], NATIVE_TOOLCHAIN, 'toolchain must execute on the build architecture');
  assert.ok(parsed[0].includes('RUN npm install --global pnpm@11.8.0'));
  for (const [index, name] of buildNames.entries()) {
    const build = parsed[index + 1];
    assert.equal(build[0], `FROM toolchain AS ${name}`, 'build stages must inherit the native toolchain');
    if (name === 'runtime-certificates') {
      assert.ok(build.some(line => /apt-get install -y --no-install-recommends ca-certificates/.test(line)));
      continue;
    }
    if (name === 'runtime-dependencies') {
      assert.ok(build.includes('COPY packages/wechat-text /work/packages/wechat-text'));
      assert.ok(build.includes('ARG TARGETARCH'));
      const install = build.find(line => line.startsWith('RUN case '));
      assert.match(install, /amd64\) CODEX_CPU=x64/);
      assert.match(install, /arm64\) CODEX_CPU=arm64/);
      assert.match(install, /supportedArchitectures:/);
      assert.match(install, /os: \[linux\]/);
      assert.match(install, /cpu: \[%s\]/);
      assert.match(install, /libc: \[glibc\]/);
      assert.match(install, /pnpm install --prod --frozen-lockfile/);
      assert.ok(build.includes('COPY gateway/patches ./patches'));
      continue;
    }
    assert.ok(build.some(line => /^RUN pnpm install --frozen-lockfile(?: |$)/.test(line)));
    if (name === 'web-build') assert.ok(build.includes('RUN pnpm run build'));
    else {
      assert.ok(build.includes('COPY packages/wechat-text /work/packages/wechat-text'));
      assert.ok(build.includes(component === 'gateway' ? 'RUN pnpm run build' : 'RUN pnpm run build && pnpm prune --prod'));
      assert.ok(build.includes(`WORKDIR /work/${component}`));
      assert.ok(build.includes('COPY scripts/clean-build.mjs /work/scripts/clean-build.mjs'));
    }
  }
  const runtime = parsed.at(-1);
  // An unqualified final FROM uses the requested target platform, not BUILDPLATFORM.
  assert.equal(runtime[0], `FROM ${BASE_IMAGE}`);
  assert.deepEqual(runtime.filter(line => /^RUN\s/i.test(line)).map(line => line.replace(/\s+/g, ' ')),
    component === 'controller' ? [SKILL_RUNTIME_INSTALL, CONTROLLER_RUNTIME_INSTALL, SKILL_RUNTIME_PERMISSIONS]
      : [SKILL_RUNTIME_INSTALL, SKILL_RUNTIME_PERMISSIONS],
    'only reviewed target-platform skill dependencies, pinned CLI, writable directories and skill permissions may be installed');
  assert.ok(runtime.indexOf(SKILL_RUNTIME_PERMISSIONS) > runtime.indexOf('COPY deploy/skills/ /etc/codex/skills/'));
  assert.ok(runtime.indexOf(SKILL_RUNTIME_PERMISSIONS) < runtime.indexOf('USER node'));
  assert.ok(runtime.includes('USER node'));
  assert.ok(runtime.includes('WORKDIR /app'));
  const sourceStage = buildNames[0];
  const allowedCopies = ['package.json', 'node_modules', 'dist'].map(artifact =>
    `COPY --from=${component === 'gateway' && artifact === 'node_modules' ? 'runtime-dependencies' : sourceStage} --chown=node:node /work/${component}/${artifact} ./${artifact}`);
  if (component === 'controller') {
    const certificates = parsed.at(-2);
    assert.equal(certificates[0], 'FROM toolchain AS runtime-certificates');
    assert.deepEqual(certificates.slice(1).map(line => line.replace(/\s+/g, ' ')), [
      'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*',
    ], 'certificates must come from the native toolchain, without adding other runtime artifacts');
    allowedCopies.unshift('COPY --from=runtime-certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt');
    allowedCopies.push('COPY --from=web-build --chown=node:node /web/dist ./web');
    assert.ok(runtime.some(line => /^ENV\s/.test(line) && line.includes('SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt')));
    assert.ok(runtime.includes('CMD ["node", "dist/index.js"]'));
  } else {
    assert.ok(parsed[1].includes('RUN mkdir -p /runtime/etc/super-leader /runtime/var/lib/super-leader-gateway'));
    for (const directory of ['/etc/super-leader', '/var/lib/super-leader-gateway']) {
      allowedCopies.push(`COPY --from=build --chown=node:node /runtime${directory} ${directory}`);
    }
    allowedCopies.push('COPY --from=runtime-certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt');
    assert.ok(runtime.includes('ENTRYPOINT ["node", "dist/index.js"]'));
    assert.ok(runtime.includes('CMD ["--run"]'));
  }
  allowedCopies.push('COPY deploy/skills/ /etc/codex/skills/');
  assert.deepEqual(runtime.filter(line => /^(?:COPY|ADD)\s/i.test(line)), allowedCopies,
    'only reviewed runtime artifacts may cross architectures');
}

test('Controller and Gateway compile natively and install skill dependencies for the target platform', () => {
  assertImageContract(controllerDockerfile, 'controller');
  assertImageContract(gatewayDockerfile, 'gateway');
});

test('image contracts reject emulated toolchains, unpruned dependencies and leaked web tooling', () => {
  for (const [source, component] of [[controllerDockerfile, 'controller'], [gatewayDockerfile, 'gateway']]) {
    assert.throws(() => assertImageContract(source.replace('--platform=$BUILDPLATFORM ', ''), component));
    assert.throws(() => assertImageContract(source.replace(`FROM ${BASE_IMAGE}\n`, `FROM ${BASE_IMAGE}\nRUN node --version\n`), component));
    assert.throws(() => assertImageContract(source.replace(SKILL_RUNTIME_PERMISSIONS, ''), component));
    assert.throws(() => assertImageContract(source.replace(SKILL_RUNTIME_PERMISSIONS, 'RUN chmod -R go+w /etc/codex/skills'), component));
    const unpruned = component === 'controller' ? source.replace(' && pnpm prune --prod', '') : source.replace('pnpm install --prod ', 'pnpm install ');
    assert.throws(() => assertImageContract(unpruned, component));
    assert.throws(() => assertImageContract(source.replace(`FROM ${BASE_IMAGE}\n`, `FROM --platform=$BUILDPLATFORM ${BASE_IMAGE}\n`), component));
    assert.throws(() => assertImageContract(`${source}\nCOPY --from=toolchain /usr/local/bin/pnpm /usr/local/bin/pnpm\n`, component));
    assert.throws(() => assertImageContract(source.replace('chmod -R go-w', 'chmod -R a+w'), component));
  }
  assert.throws(() => assertImageContract(controllerDockerfile.replace('/web/dist ./web', '/web/node_modules ./web'), 'controller'));
  assert.throws(() => assertImageContract(controllerDockerfile.replace('FROM toolchain AS web-build', `FROM ${BASE_IMAGE} AS web-build`), 'controller'));
  assert.throws(() => assertImageContract(controllerDockerfile.replace('@openai/codex@0.163.0', '@openai/codex@latest'), 'controller'));
  assert.throws(() => assertImageContract(controllerDockerfile.replace('chown node:node /var/lib/super-leader-background', 'chmod 777 /var/lib/super-leader-background'), 'controller'));
  assert.throws(() => assertImageContract(controllerDockerfile.replace('FROM toolchain AS runtime-certificates', `FROM ${BASE_IMAGE} AS runtime-certificates`), 'controller'));
  assert.throws(() => assertImageContract(controllerDockerfile.replace('ca-certificates \\', 'ca-certificates curl \\'), 'controller'));
  assert.throws(() => assertImageContract(gatewayDockerfile.replace('--chown=node:node /runtime/etc/super-leader', '/runtime/etc/super-leader'), 'gateway'));
  assert.throws(() => assertImageContract(gatewayDockerfile.replace('amd64) CODEX_CPU=x64', 'amd64) CODEX_CPU=arm64'), 'gateway'));
  assert.throws(() => assertImageContract(gatewayDockerfile.replace('FROM toolchain AS runtime-dependencies', `FROM ${BASE_IMAGE} AS runtime-dependencies`), 'gateway'));
});

test('runtime dependency roots allow reviewed JavaScript packages and target-selected Codex executables', () => {
  const controller = JSON.parse(readFileSync(new URL('../../../controller/package.json', import.meta.url), 'utf8'));
  const gateway = JSON.parse(readFileSync(new URL('../../../gateway/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(controller.dependencies, {
    '@super-leader/wechat-text': 'file:../packages/wechat-text',
    compression: '^1.8.2', 'cron-parser': '^5.10.2', dotenv: '^18.0.6', express: '^5.2.1',
    pg: '^8.23.1', ws: '^8.22.0', zod: '^4.6.5',
  }, 'new runtime dependencies require a platform-independence review');
  for (const manifest of [controller, gateway]) {
    assert.deepEqual(manifest.optionalDependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
  }
  assert.deepEqual(gateway.dependencies, {
    '@super-leader/wechat-text': 'file:../packages/wechat-text',
    '@modelcontextprotocol/sdk': '1.32.1', '@openai/codex-sdk': '0.163.0',
  }, 'new runtime dependencies require a platform and install-script review');
  const lock = readFileSync(new URL('../../../controller/pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(lock, /^  (?:pg-native|bufferutil|utf-8-validate)@/m,
    'optional native peers must not become installed runtime packages');
  const gatewayLock = readFileSync(new URL('../../../gateway/pnpm-lock.yaml', import.meta.url), 'utf8');
  for (const cpu of ['x64', 'arm64']) {
    assert.match(gatewayLock, new RegExp(`'@openai/codex@0\\.163\\.0-linux-${cpu}':\\n[\\s\\S]*?cpu: \\[${cpu}\\]\\n    os: \\[linux\\]`));
  }
});

test('shared WeChat text renderer is a self-contained portable JavaScript package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../packages/wechat-text/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, '@super-leader/wechat-text');
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  assert.deepEqual(manifest.scripts ?? {}, {});
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, './index.js');
});

test('Gateway cannot switch away from the fixed Docker and CI package manager', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../gateway/package.json', import.meta.url), 'utf8'));
  const lock = readFileSync(new URL('../../../gateway/pnpm-lock.yaml', import.meta.url), 'utf8');
  assert.equal(manifest.devEngines.packageManager.version, '11.8.0');
  assert.match(lock, /packageManagerDependencies:\s+'@pnpm\/exe':\s+specifier: 11\.8\.0\s+version: 11\.8\.0\s+pnpm:\s+specifier: 11\.8\.0\s+version: 11\.8\.0/);
});
