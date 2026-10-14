import assert from 'node:assert/strict';
import test from 'node:test';
import { execCompose, selectComposeCommand } from '../../../scripts/lib/compose-command.mjs';

test('Compose plugin is preferred without probing standalone when available', () => {
  const calls = [];
  const env = { PATH: 'synthetic-path' };
  const selected = selectComposeCommand({ env, execute(command, args, options) {
    calls.push({ command, args });
    assert.equal(options.env, env);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 10000);
    return 'Docker Compose version fixture';
  } });
  assert.deepEqual(selected, { command: 'docker', args: ['compose'] });
  assert.deepEqual(calls, [{ command: 'docker', args: ['compose', 'version'] }]);
});

test('standalone is selected only after plugin detection fails', () => {
  const calls = [];
  const selected = selectComposeCommand({ execute(command, args) {
    calls.push([command, args]);
    if (command === 'docker') throw Object.assign(new Error('plugin unavailable'), { status: 1 });
    return 'Docker Compose version fixture';
  } });
  assert.deepEqual(selected, { command: 'docker-compose', args: [] });
  assert.deepEqual(calls, [['docker', ['compose', 'version']], ['docker-compose', ['version']]]);
});

test('both missing Compose implementations produce a clear redacted failure', () => {
  assert.throws(() => selectComposeCommand({ execute() {
    throw Object.assign(new Error('private-diagnostic-do-not-print'), { code: 'ENOENT' });
  } }), error => {
    assert.match(error.message, /Docker Compose is unavailable/);
    assert.match(error.message, /docker compose: not installed/);
    assert.match(error.message, /docker-compose: not installed/);
    assert.doesNotMatch(error.message, /private-diagnostic/);
    return true;
  });
});

test('nonzero version detection cannot silently select a broken implementation', () => {
  assert.throws(() => selectComposeCommand({ execute() {
    throw Object.assign(new Error('private-version-stderr'), { status: 2 });
  } }), /docker compose: exit 2; docker-compose: exit 2/);
});

test('execCompose forwards an argument array and synthetic execution options without a shell', () => {
  const calls = [];
  const env = { PATH: 'synthetic-path', CONTROLLER_TOKEN: 'synthetic' };
  const output = execCompose(['-f', 'path with spaces.yaml', 'config', '--format', 'json'],
    { env, encoding: 'utf8', timeout: 10000 }, (command, args, options) => {
      calls.push([command, args, options]);
      return args.at(-1) === 'version' ? 'fixture' : '{"services":{}}';
    });
  assert.equal(output, '{"services":{}}');
  assert.deepEqual(calls[1].slice(0, 2), ['docker', ['compose', '-f', 'path with spaces.yaml', 'config', '--format', 'json']]);
  assert.equal(calls[1][2].env, env);
  assert.equal(calls[1][2].shell, false);
});

test('Compose execution failure propagates without fallback or replay', () => {
  const calls = [];
  const failure = Object.assign(new Error('fixture config invalid'), { status: 17 });
  assert.throws(() => execCompose(['config'], {}, (command, args) => {
    calls.push([command, args]);
    if (args.at(-1) === 'version') return 'fixture';
    throw failure;
  }), error => error === failure);
  assert.deepEqual(calls, [['docker', ['compose', 'version']], ['docker', ['compose', 'config']]]);
});

test('execCompose rejects non-array or non-string arguments before command detection', () => {
  for (const args of ['config', ['config', 1]]) {
    assert.throws(() => execCompose(args, {}, () => assert.fail('must not execute')), /array of strings/);
  }
});
