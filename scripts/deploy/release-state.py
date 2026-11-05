#!/usr/bin/env python3
"""Read-only runtime proof and atomic receipts for successful releases."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

BUNDLE_FILES = (
    'compose.yaml', 'compose.release.yaml', 'compose.production.yaml',
    'compose.gateway.yaml', 'codex-seccomp.json', 'remote-release.sh', 'release-state.py',
)
SERVICES = ('controller', 'gateway')
RECEIPT = 'deployment-receipt.json'
WINDOW = '82800000'
HEX = re.compile(r'^[0-9a-f]{64}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')
DOCKER_TIMEOUT = 15
LOCK_POLL = 0.1


class StateError(Exception):
    """An operational failure, never evidence that a deployment may be skipped."""


class Drift(Exception):
    """A valid observation that no longer matches the accepted deployment."""


def digest(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def fingerprint(bundle):
    return digest(b''.join(name.encode() + b'\0' +
                           digest((bundle / name).read_bytes()).encode() + b'\n'
                           for name in BUNDLE_FILES))


def protected_bytes(path):
    with path.open('rb') as stream:
        if stat.S_IMODE(os.fstat(stream.fileno()).st_mode) & 0o077:
            raise StateError('unsafe_permissions')
        return stream.read()


def docker(*args):
    try:
        result = subprocess.run(['docker', *args], capture_output=True,
                                text=True, timeout=DOCKER_TIMEOUT, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StateError('docker_failure') from error
    if result.returncode:
        raise StateError('docker_failure')
    return result.stdout


def inspect(*args):
    try:
        values = json.loads(docker(*args))
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            raise ValueError('invalid inspection')
        return values[0]
    except (ValueError, TypeError) as error:
        raise StateError('docker_response') from error


def runtime(release_dir, revision):
    result = {}
    for service in SERVICES:
        containers = docker('ps', '--all', '--quiet', '--filter',
                            'label=com.docker.compose.project=super-leader', '--filter',
                            'label=com.docker.compose.oneoff=False', '--filter',
                            'label=com.docker.compose.service=' + service).split()
        if len(containers) != 1:
            raise Drift('service_count')
        container = inspect('inspect', containers[0])
        try:
            config = container['Config']
            labels = config['Labels']
            state = container['State']
            image_id = container['Image']
            expected_image = 'super-leader-' + service + ':' + revision
            if (labels.get('com.docker.compose.project') != 'super-leader' or
                    labels.get('com.docker.compose.service') != service or
                    labels.get('com.docker.compose.project.working_dir') != str(release_dir) or
                    labels.get('org.opencontainers.image.revision') != revision or
                    config['Image'] != expected_image or
                    not IMAGE_ID.fullmatch(image_id) or state['Status'] != 'running' or
                    state.get('Health', {}).get('Status') != 'healthy'):
                raise Drift('runtime_identity')
            image = inspect('image', 'inspect', expected_image)
            if (image['Id'] != image_id or image['Os'] != 'linux' or image['Architecture'] != 'amd64' or
                    image['Config']['Labels'].get('org.opencontainers.image.revision') != revision):
                raise Drift('image_identity')
            if service == 'gateway':
                windows = [entry for entry in config['Env'] if entry.startswith('GATEWAY_CONTEXT_WINDOW_MS=')]
                if windows != ['GATEWAY_CONTEXT_WINDOW_MS=' + WINDOW]:
                    raise Drift('runtime_config')
            # Preserve configuration, excluding dynamically allocated network identities.
            networks = {name: {key: network.get(key) for key in
                              ('Aliases', 'Links', 'IPAMConfig', 'DriverOpts')}
                        for name, network in container['NetworkSettings']['Networks'].items()}
            snapshot = {'Config': config, 'HostConfig': container['HostConfig'],
                        'Mounts': container['Mounts'], 'Networks': networks}
            result[service] = {'image_id': image_id, 'runtime_sha256': digest(canonical(snapshot))}
        except (KeyError, TypeError, AttributeError) as error:
            raise StateError('docker_response') from error
    return result


def env_hashes(args):
    controller = Path(args.env_file)
    if not controller.is_absolute():
        controller = args.release_dir / controller
    hashes = {'release_env_sha256': digest(protected_bytes(args.release_dir / '.runtime/release.env')),
              'controller_env_sha256': digest(protected_bytes(controller))}
    if (args.expected_controller_env_sha256 is not None and
            hashes['controller_env_sha256'] != args.expected_controller_env_sha256):
        raise StateError('controller_environment_changed')
    return hashes


def valid_receipt(receipt):
    if (not isinstance(receipt, dict) or receipt.get('schema') != 1 or
            not isinstance(receipt.get('revision'), str) or not SHA.fullmatch(receipt['revision'])):
        return False
    for key in ('fingerprint', 'release_env_sha256', 'controller_env_sha256'):
        if not isinstance(receipt.get(key), str) or not HEX.fullmatch(receipt[key]):
            return False
    services = receipt.get('services')
    if not isinstance(services, dict) or set(services) != set(SERVICES):
        return False
    for service in SERVICES:
        state = services[service]
        if (not isinstance(state, dict) or not isinstance(state.get('image_id'), str) or
                not IMAGE_ID.fullmatch(state['image_id']) or
                not isinstance(state.get('runtime_sha256'), str) or not HEX.fullmatch(state['runtime_sha256'])):
            return False
    return True


@contextlib.contextmanager
def probe_lock(args):
    try:
        lock = (args.release_dir / '.runtime/activation.lock').open('rb')
    except FileNotFoundError:
        raise Drift('missing_lock') from None
    with lock:
        deadline = time.monotonic() + args.lock_timeout
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StateError('activation_busy') from None
                time.sleep(min(LOCK_POLL, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def probe(args, locked=True):
    try:
        with probe_lock(args) if locked else contextlib.nullcontext():
            try:
                raw = protected_bytes(args.release_dir / '.runtime' / RECEIPT)
            except FileNotFoundError:
                raise Drift('missing_receipt') from None
            try:
                receipt = json.loads(raw)
            except (ValueError, UnicodeError):
                raise Drift('invalid_receipt') from None
            if not valid_receipt(receipt):
                raise Drift('invalid_receipt')
            if receipt['revision'] != args.revision:
                raise Drift('revision_changed')
            if receipt['fingerprint'] != args.fingerprint:
                raise Drift('bundle_changed')
            try:
                hashes = env_hashes(args)
            except FileNotFoundError:
                raise Drift('missing_environment') from None
            if any(receipt[key] != value for key, value in hashes.items()):
                raise Drift('environment_changed')
            if runtime(args.release_dir, args.revision) != receipt['services']:
                raise Drift('runtime_changed')
            if env_hashes(args) != hashes:
                raise Drift('environment_changed')
        decision, reason = 'duplicate_skipped', 'healthy_receipt_match'
    except Drift as error:
        decision, reason = 'deploy_required', str(error)
    print(json.dumps({'schema': 1, 'revision': args.revision, 'decision': decision, 'reason': reason}))
    return 0 if locked or decision == 'duplicate_skipped' else 3


def record(args):
    hashes = env_hashes(args)
    receipt = {'schema': 1, 'revision': args.revision, 'fingerprint': fingerprint(args.bundle_dir),
               **hashes, 'services': runtime(args.release_dir, args.revision)}
    if env_hashes(args) != hashes:
        raise StateError('environment_changed')
    directory = args.release_dir / '.runtime'
    fd, temporary = tempfile.mkstemp(prefix='.deployment-receipt-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(receipt) + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / RECEIPT)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    fp = commands.add_parser('fingerprint')
    fp.add_argument('--bundle-dir', type=Path, required=True)
    for command in ('probe', 'record', 'check'):
        sub = commands.add_parser(command)
        sub.add_argument('--release-dir', type=Path, required=True)
        sub.add_argument('--revision', required=True)
        sub.add_argument('--env-file', default='.runtime/controller.env')
        sub.add_argument('--expected-controller-env-sha256', required=command == 'record')
        if command != 'record':
            sub.add_argument('--fingerprint', required=True)
        if command == 'probe':
            sub.add_argument('--lock-timeout', type=float, default=60)
        if command == 'record':
            sub.add_argument('--bundle-dir', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'fingerprint':
        print(fingerprint(args.bundle_dir))
        return
    if not SHA.fullmatch(args.revision) or not args.release_dir.is_absolute():
        parser.error('expected absolute release directory and full lowercase revision')
    if args.expected_controller_env_sha256 is not None and not HEX.fullmatch(args.expected_controller_env_sha256):
        parser.error('expected controller environment SHA256')
    if args.command != 'record' and not HEX.fullmatch(args.fingerprint):
        parser.error('expected fingerprint')
    if args.command == 'probe' and not 0 <= args.lock_timeout <= 300:
        parser.error('expected fingerprint and bounded lock timeout')
    if args.command == 'record':
        return record(args)
    return probe(args, locked=args.command == 'probe')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (StateError, Drift, OSError, ValueError) as error:
        reason = str(error) if isinstance(error, (StateError, Drift)) else 'state_io_failure'
        print(json.dumps({'schema': 1, 'error': reason}), file=sys.stderr)
        sys.exit(1)
