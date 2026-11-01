import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TransferFailure } from './transfer-process.mjs';

export const RELEASE_FILES = Object.freeze(['controller.tar', 'gateway.tar', 'release.sha256', 'manifest.env',
  'compose.release.yaml', 'compose.yaml', 'compose.production.yaml', 'compose.gateway.yaml',
  'codex-seccomp.json', 'remote-release.sh']);
export const DIAGNOSTIC_FILES = Object.freeze(['success.bin', 'cancel.bin']);
export const DIAGNOSTIC_PAYLOAD_LIMIT = 2 * 1024 * 1024;

export async function manifestFor(root, names, signal) {
  const files = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const path = join(root, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size)) throw new TransferFailure('local_file');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    files.push({ name, bytes: stat.size, sha256: hash.digest('hex') });
  }
  return files;
}

// Python is already available on the deployment host. All operations are confined
// to one newly-created stage and a fixed file list, guarded by an ownership token.
export const REMOTE_FILES = String.raw`
import sys,os,json,hashlib,stat,base64
stage,owner,op,encoded=sys.argv[1:]
files=json.loads(base64.b64decode(encoded))
marker=os.path.join(stage,'.transfer-owner')
if op=='create':
 os.makedirs(os.path.dirname(stage),mode=0o700,exist_ok=True)
 os.mkdir(stage,0o700)
 with open(marker,'x') as f:f.write(owner)
 os.chmod(marker,0o600)
else:
 if os.path.islink(stage) or not os.path.isdir(stage) or os.path.islink(marker) or not os.path.isfile(marker):sys.exit(73)
 with open(marker) as f:
  if f.read()!=owner:sys.exit(73)
if op=='status':
 sizes=[]
 for f in files:
  path=os.path.join(stage,f['name'])
  try:s=os.lstat(path)
  except FileNotFoundError:s=None
  if s is not None and not stat.S_ISREG(s.st_mode):sys.exit(74)
  sizes.append(s.st_size if s else 0)
 print(json.dumps({'bytes':sizes}))
elif op=='verify':
 for f in files:
  path=os.path.join(stage,f['name'])
  s=os.lstat(path)
  if not stat.S_ISREG(s.st_mode) or s.st_size!=f['bytes']:sys.exit(74)
  h=hashlib.sha256()
  with open(path,'rb') as stream:
   for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk)
  if h.hexdigest()!=f['sha256']:sys.exit(74)
 print(json.dumps({'verified':True}))
elif op=='cleanup':
 for name in [f['name'] for f in files]+['release.env.next']:
  try:os.unlink(os.path.join(stage,name))
  except FileNotFoundError:pass
 if set(os.listdir(stage))!={'.transfer-owner'}:sys.exit(75)
 os.unlink(marker)
 os.rmdir(stage)
 print(json.dumps({'cleanup':'confirmed'}))
elif op=='create':print(json.dumps({'owned':True}))
else:sys.exit(76)
`;

export function quoteShell(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
