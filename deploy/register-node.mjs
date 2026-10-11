import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const NODE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const TOKEN_MIN_LENGTH = 8;
export const TOKEN_MAX_LENGTH = 512;
const UNSAFE_TOKEN_CHARACTER_PATTERN = /[^A-Za-z0-9_-]/;

export function parseCliArgs(argv = process.argv.slice(2)) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      'node-id': { type: 'string' },
      'token-file': { type: 'string' },
      'env-file': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
}

export function checkPermissions(filePath, label) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error(`${label} path must be a non-empty string`);
  }
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    throw new Error(`${label} file does not exist`);
  }

  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} file must not be a symbolic link`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} path must be a regular file`);
  }

  const fileMode = stat.mode & 0o777;
  if (fileMode !== 0o600) {
    throw new Error(`${label} file must have 0600 permissions (found 0${fileMode.toString(8)})`);
  }

  const parentDir = dirname(resolved);
  if (!existsSync(parentDir)) {
    throw new Error(`Parent directory for ${label} does not exist`);
  }
  const dirStat = lstatSync(parentDir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(`Parent directory for ${label} must not be a symbolic link`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`Parent directory for ${label} must be a directory`);
  }

  const dirMode = dirStat.mode & 0o777;
  if (dirMode !== 0o700) {
    throw new Error(`Parent directory for ${label} must have 0700 permissions (found 0${dirMode.toString(8)})`);
  }

  return resolved;
}

export function validateNodeId(nodeId) {
  if (typeof nodeId !== 'string' || !nodeId.trim()) {
    throw new Error('Node ID must be a non-empty string');
  }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    throw new Error('Node ID contains invalid characters (must match alphanumeric, _, - up to 64 chars)');
  }
  return nodeId;
}

function validateToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token must be a non-empty string');
  }
  if (token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH) {
    throw new Error(`Token length must be between ${TOKEN_MIN_LENGTH} and ${TOKEN_MAX_LENGTH} characters`);
  }
  if (UNSAFE_TOKEN_CHARACTER_PATTERN.test(token)) {
    throw new Error('Token must contain only ASCII letters, digits, _ or -');
  }
  return token;
}

export function readValidToken(tokenFilePath) {
  const resolved = checkPermissions(tokenFilePath, 'Token');
  let content;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error('Failed to read token file');
  }
  return validateToken(content.replace(/\r?\n$/, ''));
}

export function inspectAndPatchEnv(envContent, nodeId, token) {
  validateToken(token);
  const lines = envContent.split(/(\r?\n)/);
  let tokensLineIdx = -1;
  let lineCount = 0;
  let currentVal = '';

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('#') && /^(?:export\s+)?NODE_TOKENS\s*=/.test(trimmed)) {
      if (!/^NODE_TOKENS=/.test(line)) {
        throw new Error('Env file contains ambiguous NODE_TOKENS entry (export prefix or whitespace around key is not allowed)');
      }
    }
    const match = line.match(/^NODE_TOKENS=(.*)$/);
    if (match) {
      lineCount++;
      tokensLineIdx = i;
      currentVal = match[1].trim();
    }
  }

  if (lineCount === 0) {
    throw new Error('Env file missing required NODE_TOKENS= entry');
  }
  if (lineCount > 1) {
    throw new Error('Env file contains multiple NODE_TOKENS= entries');
  }

  let rawJson = currentVal;
  let quoteStyle = 'none';
  if (rawJson.startsWith("'") && rawJson.endsWith("'") && rawJson.length >= 2) {
    quoteStyle = 'single';
    rawJson = rawJson.slice(1, -1).trim();
  } else if (rawJson.startsWith('"') && rawJson.endsWith('"') && rawJson.length >= 2) {
    quoteStyle = 'double';
    rawJson = rawJson.slice(1, -1).trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('NODE_TOKENS in env file is not valid JSON (raw value redacted for security)');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('NODE_TOKENS in env file must be a JSON object');
  }

  const tokenToNode = new Map();
  for (const [existingNode, existingToken] of Object.entries(parsed)) {
    if (typeof existingToken !== 'string') {
      throw new Error(`NODE_TOKENS in env file contains non-string token for node '${existingNode}'`);
    }
    if (tokenToNode.has(existingToken)) {
      throw new Error('NODE_TOKENS in env file contains duplicate token across nodes');
    }
    tokenToNode.set(existingToken, existingNode);
  }

  const existingOwnerOfToken = tokenToNode.get(token);
  if (existingOwnerOfToken && existingOwnerOfToken !== nodeId) {
    throw new Error(`Token is already assigned to node '${existingOwnerOfToken}'; duplicate token rejected`);
  }

  if (Object.prototype.hasOwnProperty.call(parsed, nodeId)) {
    if (parsed[nodeId] === token) {
      return {
        alreadyRegistered: true,
        changed: false,
        nodeCount: Object.keys(parsed).length,
        newContent: envContent,
      };
    }
    throw new Error(`Node '${nodeId}' is already registered with a different token; refusing to overwrite`);
  }

  const updatedTokens = { ...parsed, [nodeId]: token };
  const newJson = JSON.stringify(updatedTokens);
  const newLineValue = quoteStyle === 'single' ? `NODE_TOKENS='${newJson}'` : `NODE_TOKENS=${newJson}`;

  lines[tokensLineIdx] = newLineValue;
  const newContent = lines.join('');

  return {
    alreadyRegistered: false,
    changed: true,
    nodeCount: Object.keys(updatedTokens).length,
    newContent,
  };
}

export function registerNode({ nodeId, tokenFilePath, envPath, apply = false, _onBeforeCommit = null }) {
  if (!nodeId || (typeof nodeId === 'string' && !nodeId.trim())) {
    throw new Error('Missing required option: --node-id <id>');
  }
  if (!tokenFilePath) throw new Error('Missing required option: --token-file <path>');
  if (!envPath) throw new Error('Missing required option: --env-file <path>');

  const validNodeId = validateNodeId(nodeId);
  const validToken = readValidToken(tokenFilePath);
  const resolvedEnv = checkPermissions(envPath, 'Env');

  let initialContent;
  try {
    initialContent = readFileSync(resolvedEnv, 'utf8');
  } catch {
    throw new Error('Failed to read env file');
  }

  const { alreadyRegistered, changed, nodeCount, newContent } = inspectAndPatchEnv(
    initialContent,
    validNodeId,
    validToken
  );

  if (!apply || !changed) {
    return {
      nodeId: validNodeId,
      nodeCount,
      alreadyRegistered,
      changed: apply ? false : changed,
      applied: false,
      dryRun: !apply,
      summary: alreadyRegistered
        ? `Node '${validNodeId}' already registered with matching token in env file`
        : (apply ? 'No changes required' : `Dry run: Node '${validNodeId}' ready to register in env file`),
    };
  }

  if (typeof _onBeforeCommit === 'function') {
    _onBeforeCommit();
  }

  const recheckedEnv = checkPermissions(envPath, 'Env');
  let currentContent;
  try {
    currentContent = readFileSync(recheckedEnv, 'utf8');
  } catch {
    throw new Error('Failed to re-read env file before write');
  }
  if (currentContent !== initialContent) {
    throw new Error('Concurrent modification detected on env file; aborting to prevent lost update');
  }

  const dir = dirname(recheckedEnv);
  const tempPath = join(dir, `.env-register-${Date.now()}-${randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = openSync(tempPath, 'w', 0o600);
    writeFileSync(fd, newContent, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, recheckedEnv);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (closeErr) {
        if (closeErr?.code !== 'EBADF') throw new Error('Failed to close temporary env file descriptor');
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== 'ENOENT') throw new Error('Failed to remove temporary env file');
      }
    }
  }

  return {
    nodeId: validNodeId,
    nodeCount,
    alreadyRegistered: false,
    changed: true,
    applied: true,
    dryRun: false,
    summary: `Successfully registered node '${validNodeId}' in env file`,
  };
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
})();

if (isDirectRun) {
  try {
    const { values } = parseCliArgs();
    if (values.help) {
      console.log(`Usage: node deploy/register-node.mjs --node-id <id> --token-file <path> --env-file <path> [--apply] [--help]

Safely registers a node ID and its token into NODE_TOKENS in the controller .env file.

Options:
  --node-id <id>        Node identifier (alphanumeric, _, -, max 64 chars)
  --token-file <path>   Path to node token file (ASCII letters/digits/_/-, 8-512 chars; 0600 in 0700 dir)
  --env-file <path>     Path to controller .env file (must be 0600 in 0700 dir)
  --apply               Apply changes (default is dry-run mode)
  -h, --help            Show this help message`);
      process.exit(0);
    }

    const result = registerNode({
      nodeId: values['node-id'],
      tokenFilePath: values['token-file'],
      envPath: values['env-file'],
      apply: values.apply ?? false,
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message || 'Operation failed'}`);
    process.exit(1);
  }
}
