import { spawnSync } from 'node:child_process';

const FIXTURE_TIMEOUT_MS = 30_000;

/** Run the real CLI with synthetic config and a fetch replacement that cannot contact a service. */
export function runSendEligibilityCli(cli, args, status, { allowCommands = false, commandStatus = 'completed' } = {}) {
  const preload = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const readFile = fs.readFile;
    const stat = fs.stat;
    const isConfig = path => String(path).endsWith('/.runtime/local.json');
    fs.stat = (path, ...args) => isConfig(path) ? Promise.resolve({ mode: 0o600 }) : stat(path, ...args);
    fs.readFile = (path, ...args) => isConfig(path) ? Promise.resolve(JSON.stringify({
      nodeId: 'synthetic-node', postgresPassword: 'a'.repeat(64),
      controllerToken: 'b'.repeat(64), nodeToken: 'c'.repeat(64), allowedChatIds: [],
    })) : readFile(path, ...args);
    syncBuiltinESMExports();
    const status = ${JSON.stringify(status)};
    let posts = 0;
    let command;
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (url, options = {}) => {
      const target = new URL(url);
      assert.equal(target.origin, 'http://127.0.0.1:8790', 'Fixture rejected an unexpected Controller');
      const method = options.method ?? 'GET';
      if (method === 'GET' && target.pathname === '/health') return json({ ok: true });
      if (method === 'GET' && target.pathname === '/v1/status') return json(status);
      if (method === 'POST' && target.pathname === '/v1/commands') {
        posts++;
        assert.equal(${allowCommands}, true, 'Fixture forbids command submission');
        const request = JSON.parse(options.body);
        assert.equal(request.action, 'send');
        if (command) assert.equal(request.requestId, command.requestId);
        command ??= { ...request, commandId: 'cmd_synthetic', status: ${JSON.stringify(commandStatus)},
          turnId: 'turn_synthetic', output: request.prompt };
        return json(command);
      }
      if (method === 'GET' && target.pathname === '/v1/commands/cmd_synthetic') {
        assert(command, 'Fixture command must be submitted before polling');
        return json(command);
      }
      throw new Error('Fixture rejected an unexpected request: ' + method + ' ' + target.pathname);
    };
    process.on('exit', () => console.error('FIXTURE_POSTS=' + posts));
  `;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, cli, ...args], {
    encoding: 'utf8', timeout: FIXTURE_TIMEOUT_MS,
    env: { PATH: process.env.PATH, CONTROLLER_TOKEN: 'synthetic-test-token', SUPER_LEADER_NO_DOTENV: '1' },
  });
  if (result.error) throw result.error;
  return result;
}
