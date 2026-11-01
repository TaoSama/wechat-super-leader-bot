import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localDockerEnvironment, verificationEnvironment } from '../../scripts/verify.mjs';
import { transferConfiguration } from '../../scripts/deploy/transfer-release.mjs';
import { TransferProcesses } from '../../scripts/deploy/transfer-process.mjs';

const SERVER_IMAGE = `FROM alpine:3.22
RUN apk add --no-cache openssh-server python3 && ssh-keygen -A && passwd -d root && mkdir /fixture
CMD ["/usr/sbin/sshd","-D","-e","-f","/dev/null","-p","2222","-h","/etc/ssh/ssh_host_ed25519_key","-o","PermitRootLogin=prohibit-password","-o","PasswordAuthentication=no","-o","AuthorizedKeysFile=/fixture/client.pub","-o","StrictModes=no","-o","Subsystem=sftp internal-sftp"]
`;

export async function transferSshFixture() {
  const env = localDockerEnvironment(verificationEnvironment());
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-transfer-ssh-')));
  const suffix = randomUUID().slice(0, 8);
  const image = `super-leader-transfer-fixture:${suffix}`, container = `super-leader-transfer-fixture-${suffix}`;
  const command = (tool, args, options = {}) => execFileSync(tool, args,
    { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, ...options });
  let containerCreated = false, imageCreated = false, sequence = 1000;
  const close = async () => {
    try {
      if (containerCreated) command('docker', ['rm', '-f', container]);
      if (imageCreated) command('docker', ['image', 'rm', image]);
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  try {
    command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'client')]);
    command('docker', ['build', '-t', image, '-'], { input: SERVER_IMAGE });
    imageCreated = true;
    command('docker', ['create', '--name', container, '--security-opt', 'no-new-privileges',
      '-p', '127.0.0.1::2222', image]);
    containerCreated = true;
    command('docker', ['cp', join(root, 'client.pub'), `${container}:/fixture/client.pub`]);
    command('docker', ['start', container]);
    const mapping = command('docker', ['port', container, '2222/tcp']).trim();
    const port = mapping.split(':').at(-1);
    const publicKey = command('docker', ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).trim().split(' ').slice(0, 2).join(' ');
    await writeFile(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${publicKey}\n`);
    const environment = () => ({ ...env, DEPLOY_HOST: '127.0.0.1', DEPLOY_PORT: port,
      DEPLOY_USER: 'root', DEPLOY_PATH: '/tmp/release-fixture', REVISION: 'a'.repeat(40),
      GITHUB_RUN_ID: String(sequence++), GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'synthetic/fixture',
      GH_TOKEN: 'SYNTHETIC_TOKEN_MUST_NOT_LEAK', DEPLOY_SSH_PRIVATE_KEY: 'SYNTHETIC_KEY_MUST_NOT_LEAK' });
    const values = { diagnostic: true, 'key-file': join(root, 'client'), 'known-hosts-file': join(root, 'known_hosts') };
    const config = transferConfiguration(values, environment());
    const tools = new TransferProcesses();
    const deadline = Date.now() + 10_000;
    let connected = false;
    while (Date.now() < deadline) {
      const result = await tools.run('ssh', ['-F', '/dev/null', '-i', config.key, '-p', port,
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
        '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${config.knownHosts}`,
        '-o', 'ConnectTimeout=1', 'root@127.0.0.1', 'true'], { timeoutMs: 2_000 });
      if (result.code === 0) { connected = true; break; }
      await delay(100);
    }
    if (!connected) throw new Error('Isolated SSH fixture did not become ready');
    return { root, env, values, environment, close,
      python: source => command('docker', ['exec', container, 'python3', '-c', source]),
      async privateKey() { return readFile(join(root, 'client'), 'utf8'); },
    };
  } catch (error) { await close(); throw error; }
}
