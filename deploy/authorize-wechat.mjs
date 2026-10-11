import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const USER_ID_PATTERN = /^[a-zA-Z0-9_@.-]+$/;

export function parseCliArgs(argv = process.argv.slice(2)) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      credentials: { type: 'string' },
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

export function readValidUserId(credentialsPath) {
  const resolved = checkPermissions(credentialsPath, 'Credentials');
  let content;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error('Failed to read credentials file');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Invalid JSON syntax in credentials file');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Credentials JSON must be an object');
  }

  const userId = parsed.userId;
  if (typeof userId !== 'string' || !userId.trim()) {
    throw new Error('Credentials file missing or empty userId');
  }

  if (/\s|,|\n|\r/.test(userId)) {
    throw new Error('Credentials userId must not contain whitespace, comma, or newline');
  }

  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error('Credentials userId contains invalid characters (must match alphanumeric, _, @, ., -)');
  }

  return userId;
}

export function inspectAndPatchEnv(envContent, userId) {
  const lines = envContent.split(/(\r?\n)/);
  let allowedLineIdx = -1;
  let lineCount = 0;
  let currentVal = '';

  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('#') && /^(?:export\s+)?ALLOWED_CHAT_IDS\s*=/.test(trimmed)) {
      if (!/^ALLOWED_CHAT_IDS=/.test(line)) {
        throw new Error('Env file contains ambiguous ALLOWED_CHAT_IDS entry (export prefix or whitespace around key is not allowed)');
      }
    }
    const match = line.match(/^ALLOWED_CHAT_IDS=(.*)$/);
    if (match) {
      lineCount++;
      allowedLineIdx = i;
      currentVal = match[1].trim();
    }
  }

  if (lineCount === 0) {
    throw new Error('Env file missing required ALLOWED_CHAT_IDS= entry');
  }
  if (lineCount > 1) {
    throw new Error('Env file contains multiple ALLOWED_CHAT_IDS= entries');
  }

  let unquoted = currentVal;
  if ((unquoted.startsWith('"') && unquoted.endsWith('"')) || (unquoted.startsWith("'") && unquoted.endsWith("'"))) {
    unquoted = unquoted.slice(1, -1).trim();
  }

  if (unquoted === userId) {
    return {
      alreadyAuthorized: true,
      changed: false,
      newContent: envContent,
    };
  }

  if (unquoted === '') {
    lines[allowedLineIdx] = `ALLOWED_CHAT_IDS=${userId}`;
    const newContent = lines.join('');
    return {
      alreadyAuthorized: false,
      changed: true,
      newContent,
    };
  }

  throw new Error('ALLOWED_CHAT_IDS is already configured with other identity or multiple IDs; refusing to overwrite');
}

export function authorizeWechat({ credentialsPath, envPath, apply = false }) {
  if (!credentialsPath) throw new Error('Missing required option: --credentials <path>');
  if (!envPath) throw new Error('Missing required option: --env-file <path>');

  const validUserId = readValidUserId(credentialsPath);
  const resolvedEnv = checkPermissions(envPath, 'Env');

  let initialContent;
  try {
    initialContent = readFileSync(resolvedEnv, 'utf8');
  } catch {
    throw new Error('Failed to read env file');
  }

  const { alreadyAuthorized, changed, newContent } = inspectAndPatchEnv(initialContent, validUserId);

  if (!apply || !changed) {
    return {
      hasOwner: true,
      alreadyAuthorized,
      changed: apply ? false : changed,
      applied: false,
      dryRun: !apply,
      summary: alreadyAuthorized
        ? 'WeChat owner identity already authorized in env file'
        : (apply ? 'No changes required' : 'Dry run: WeChat owner identity ready to authorize in env file'),
    };
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
  const tempPath = join(dir, `.env-authorize-${Date.now()}-${randomBytes(4).toString('hex')}.tmp`);
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
    hasOwner: true,
    alreadyAuthorized: false,
    changed: true,
    applied: true,
    dryRun: false,
    summary: 'Successfully authorized WeChat owner identity in env file',
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
      console.log(`Usage: node deploy/authorize-wechat.mjs --credentials <path> --env-file <path> [--apply] [--help]

Safely authorizes the verified WeChat owner account chatId to ALLOWED_CHAT_IDS in the controller .env file.

Options:
  --credentials <path>  Path to WeChat account.json (must be 0600 in 0700 dir)
  --env-file <path>     Path to controller .env file (must be 0600 in 0700 dir)
  --apply               Apply changes (default is dry-run mode)
  -h, --help            Show this help message`);
      process.exit(0);
    }

    const result = authorizeWechat({
      credentialsPath: values.credentials,
      envPath: values['env-file'],
      apply: values.apply ?? false,
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message || 'Operation failed'}`);
    process.exit(1);
  }
}
