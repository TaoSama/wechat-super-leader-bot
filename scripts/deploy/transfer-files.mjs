import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TransferFailure } from './transfer-process.mjs';

export const RELEASE_FILES = Object.freeze(['controller.tar', 'gateway.tar', 'release.sha256', 'manifest.env',
  'compose.release.yaml', 'compose.yaml', 'compose.production.yaml', 'compose.gateway.yaml',
  'codex-seccomp.json', 'remote-release.sh', 'release-state.py']);
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

export const MAX_TRANSFER_PARTS = 64;
export const ACTIVATION_LOG = 'activation.log';
export const ACTIVATION_STATUS = 'activation.status';
const ACTIVATION_OUTPUT_BYTES = 8192;

// Python is already available on the deployment host. All operations are confined
// to one newly-created stage and a fixed file list, guarded by an ownership token.
// Activation runs in its own session with file-backed stdio, so a closed SSH channel
// cannot SIGPIPE/SIGHUP the release or its rollback; the exit status is published atomically.
export const REMOTE_FILES = String.raw`
import sys,os,json,hashlib,stat,base64,subprocess,fcntl
stage,owner,op,encoded=sys.argv[1:]
files=json.loads(base64.b64decode(encoded))
marker=os.path.join(stage,'.transfer-owner')
log=os.path.join(stage,'${ACTIVATION_LOG}')
status=os.path.join(stage,'${ACTIVATION_STATUS}')
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
elif op=='join':
 # Parallel uploads arrive as numbered parts; reassemble each before integrity verification.
 for f in files:
  count=f['parts']
  if not isinstance(count,int) or count<1 or count>${MAX_TRANSFER_PARTS}:sys.exit(74)
  target=os.path.join(stage,f['name'])
  parts=[target+'.part%02d'%i for i in range(count)]
  for part in parts:
   if os.path.islink(part) or not os.path.isfile(part):sys.exit(74)
  with open(target,'wb') as out:
   for part in parts:
    with open(part,'rb') as src:
     for chunk in iter(lambda:src.read(1048576),b''):out.write(chunk)
  for part in parts:os.unlink(part)
 print(json.dumps({'joined':True}))
elif op=='activate':
 script=os.path.join(stage,'remote-release.sh')
 os.chmod(script,0o700)
 runtime=os.path.join(files[files.index('--release-dir')+1],'.runtime')
 os.makedirs(runtime,mode=0o700,exist_ok=True)
 # One activation per release directory; the forked child keeps this lock until it finishes.
 lock=os.open(os.path.join(runtime,'activation.lock'),os.O_WRONLY|os.O_CREAT,0o600)
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:sys.exit(78)
 try:output=os.open(log,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 except FileExistsError:sys.exit(77)
 ready_read,ready_write=os.pipe()
 if os.fork()==0:
  os.close(ready_read)
  os.setsid()
  os.dup2(os.open(os.devnull,os.O_RDONLY),0);os.dup2(output,1);os.dup2(output,2)
  os.write(ready_write,b'1');os.close(ready_write)
  try:code=subprocess.call([script]+files)
  except OSError:code=126
  with open(status+'.tmp','w') as f:f.write(str(code));f.flush();os.fsync(f.fileno())
  os.replace(status+'.tmp',status)
  os._exit(0)
 os.close(ready_write)
 # A cancelled SSH session must not kill a child already acknowledged as started.
 ready=os.read(ready_read,1);os.close(ready_read)
 if ready!=b'1':sys.exit(77)
 print(json.dumps({'started':True}))
elif op=='activation':
 if not os.path.isfile(log):sys.exit(77)
 result={'exit_code':None}
 if os.path.isfile(status):
  with open(status) as f:result['exit_code']=int(f.read())
  with open(log,'rb') as f:
   f.seek(max(0,os.fstat(f.fileno()).st_size-${ACTIVATION_OUTPUT_BYTES}));result['output']=f.read().decode('utf-8','replace')
 print(json.dumps(result))
elif op=='cleanup':
 if os.path.exists(log) and not os.path.exists(status):sys.exit(77)
 names=[f['name'] for f in files]
 names+=[entry for entry in os.listdir(stage) if any(entry.startswith(name+'.part') for name in names)]
 for name in names+['release.env.next','${ACTIVATION_LOG}','${ACTIVATION_STATUS}']:
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
