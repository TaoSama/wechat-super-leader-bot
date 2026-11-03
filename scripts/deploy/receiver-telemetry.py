#!/usr/bin/env python3
"""Passive, bounded Linux receiver observations; suitable for execution through SSH stdin."""
import argparse
import datetime
import errno
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time

FILES = ('controller.tar', 'gateway.tar', 'release.sha256', 'manifest.env',
         'compose.release.yaml', 'compose.yaml', 'compose.production.yaml',
         'compose.gateway.yaml', 'codex-seccomp.json', 'remote-release.sh')
ARCHIVES = FILES[:2]
TCP_FIELDS = ('bytes_received', 'recv_queue_bytes', 'rcv_space_bytes', 'rcv_ssthresh_bytes',
              'receive_memory_bytes', 'receive_buffer_bytes', 'backlog_bytes', 'drops')
IDENTIFIERS = ('writer_pid', 'writer_start_ticks', 'file_fd', 'file_inode', 'stage_inode',
               'socket_inode', 'owner_pid', 'owner_start_ticks', 'socket_fd')
PROC_LIMIT, QUERY_LIMIT, PID_LIMIT, FD_LIMIT, CONNECTION_LIMIT = 8192, 65536, 64, 128, 16
QUERY_SECONDS, STOP_SECONDS, MAX_SECONDS, SAMPLE_SECONDS = 1.5, 1.0, 1200, 15
OUTPUT_COUNT, OUTPUT_BYTES, DEPTH_LIMIT = 128, 2 * 1024 * 1024, 16
MAX_INTEGER = 2 ** 53 - 1

class ObservationFailure(Exception):
    def __init__(self, category):
        self.category = category
        super().__init__(category)

def failure(error):
    return ObservationFailure('proc_permission' if error.errno in (errno.EACCES, errno.EPERM)
                              else 'process_exited' if error.errno in (errno.ENOENT, errno.ESRCH)
                              else 'proc_io')

class FileSystem:
    def read_text(self, path, limit=PROC_LIMIT):
        with open(path, 'r', encoding='utf-8') as stream:
            value = stream.read(limit + 1)
        if len(value) > limit:
            raise ObservationFailure('proc_limit')
        return value

    def listdir(self, path, limit):
        with os.scandir(path) as entries:
            result = []
            for entry in entries:
                result.append(entry.name)
                if len(result) > limit:
                    raise ObservationFailure('proc_limit')
        return result

    stat = staticmethod(os.stat)
    readlink = staticmethod(os.readlink)

    @staticmethod
    def fstat_fd(path):
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            return os.fstat(fd)
        finally:
            os.close(fd)

class QueryProcesses:
    """Keep ownership until both the helper and its entire process group are gone."""
    def __init__(self, stop_event=None):
        self.stop = stop_event or threading.Event()
        self.children, self.lock, self.reap_lock = {}, threading.RLock(), threading.RLock()

    @staticmethod
    def active(pid):
        try:
            os.killpg(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def children_active(self):
        with self.lock:
            # An unclosed output pipe also keeps ownership unresolved after its leader exits.
            return len(self.children)

    def group_active(self, pid, child):
        if getattr(child, 'receiver_group_gone', False):
            return False
        active = self.active(pid)
        if not active:
            child.receiver_group_gone = True
        return active

    def reap(self, pid, child):
        with self.reap_lock:
            with self.lock:
                if pid not in self.children:
                    return True
            for signum in (signal.SIGTERM, signal.SIGKILL):
                if self.group_active(pid, child):
                    try:
                        os.killpg(pid, signum)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        return False
                until = time.monotonic() + STOP_SECONDS
                while time.monotonic() < until:
                    child.poll()
                    for stream in (child.stdout, child.stderr):
                        if stream.fileno() not in child.receiver_eof:
                            try:
                                if not os.read(stream.fileno(), QUERY_LIMIT):
                                    child.receiver_eof.add(stream.fileno())
                            except BlockingIOError:
                                pass
                    if child.poll() is not None and not self.group_active(pid, child) and len(child.receiver_eof) == 2:
                        with self.lock:
                            self.children.pop(pid, None)
                        child.stdout.close()
                        child.stderr.close()
                        return True
                    time.sleep(0.02)
            return False

    def cleanup(self):
        self.stop.set()
        with self.lock:
            children = list(self.children.items())
        return all([self.reap(pid, child) for pid, child in children])

    def query(self, port, listening=False):
        until = time.monotonic() + QUERY_SECONDS
        with self.lock:
            if self.stop.is_set():
                raise ObservationFailure('cancelled')
            try:
                arguments = ['ss', '-Hnlte'] if listening else ['ss', '-Hntipem', 'state', 'established']
                child = subprocess.Popen(arguments + ['( sport = :%d )' % port], stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, start_new_session=True)
            except FileNotFoundError:
                raise ObservationFailure('ss_missing') from None
            except OSError:
                raise ObservationFailure('ss_start') from None
            child.receiver_eof = set()
            for stream in (child.stdout, child.stderr):
                os.set_blocking(stream.fileno(), False)
            self.children[child.pid] = child
        output, count, category = bytearray(), 0, None
        try:
            with selectors.DefaultSelector() as selector:
                for stream in (child.stdout, child.stderr):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ)
                while selector.get_map():
                    if self.stop.is_set():
                        category = 'cancelled'
                        break
                    if time.monotonic() >= until:
                        category = 'ss_timeout'
                        break
                    for key, _ in selector.select(min(0.05, max(0, until - time.monotonic()))):
                        chunk = os.read(key.fd, QUERY_LIMIT + 1)
                        if not chunk:
                            child.receiver_eof.add(key.fd)
                            selector.unregister(key.fileobj)
                            continue
                        count += len(chunk)
                        if count > QUERY_LIMIT:
                            category = 'ss_output_limit'
                            break
                        if key.fileobj is child.stdout:
                            output.extend(chunk)
                    if category:
                        break
                if not category:
                    try:
                        code = child.wait(timeout=max(0.001, until - time.monotonic()))
                        category = 'ss_failed' if code else None
                    except subprocess.TimeoutExpired:
                        category = 'ss_timeout'
        finally:
            cleaned = self.reap(child.pid, child)
        if not cleaned:
            self.stop.set()
            raise ObservationFailure('cleanup_unconfirmed')
        if category:
            raise ObservationFailure(category)
        return output.decode('utf-8', errors='replace')

def number(text):
    return int(text) if text is not None and re.fullmatch(r'[0-9]+', text) else None

def socket_rows(text, state):
    if not isinstance(text, str):
        raise ObservationFailure('ss_invalid')
    if len(text.encode('utf-8')) > QUERY_LIMIT:
        raise ObservationFailure('ss_output_limit')
    rows = []
    for line in text.splitlines():
        match = re.match(r'^(?:' + state + r'\s+)?([0-9]+)\s+[0-9]+\s+\S+\s+\S+(?:\s|$)', line)
        if match:
            rows.append([int(match[1]), line])
            if len(rows) > CONNECTION_LIMIT:
                raise ObservationFailure('proc_limit')
        elif line.strip():
            if not rows or not line[0].isspace():
                raise ObservationFailure('ss_invalid')
            rows[-1][1] += ' ' + line.strip()
    return rows

def parse_sockets(text):
    records = []
    for queue, value in socket_rows(text, 'ESTAB'):
        inode = number(re.search(r'\bino:([0-9]+)\b', value)[1]) if re.search(r'\bino:([0-9]+)\b', value) else None
        owners = sorted(set((int(pid), int(fd)) for pid, fd in re.findall(r'\bpid=([1-9][0-9]*),fd=([0-9]+)\b', value)))
        if inode is None or not owners:
            raise ObservationFailure('socket_owner_missing')
        metrics = dict.fromkeys(TCP_FIELDS)
        metrics['recv_queue_bytes'] = queue
        for source, target in [('bytes_received', 'bytes_received'), ('rcv_space', 'rcv_space_bytes'),
                               ('rcv_ssthresh', 'rcv_ssthresh_bytes')]:
            match = re.search(r'(?:^|\s)' + source + r':([0-9]+)(?=\s|$)', value)
            metrics[target] = number(match[1]) if match else None
        memory = re.search(r'\bskmem:\(([^)]*)\)', value)
        for source, target in [('r', 'receive_memory_bytes'), ('rb', 'receive_buffer_bytes'),
                               ('bl', 'backlog_bytes'), ('d', 'drops')]:
            match = re.search(r'(?:^|,)' + source + r'([0-9]+)(?=,|$)', memory[1]) if memory else None
            metrics[target] = number(match[1]) if match else None
        records.append({'inode': inode, 'owners': owners, 'metrics': metrics})
    return records

def parse_listeners(text):
    inodes = set()
    for _, value in socket_rows(text, 'LISTEN'):
        matches = re.findall(r'(?:^|\s)ino:([0-9]+)(?=\s|$)', value)
        if len(matches) != 1 or int(matches[0]) <= 0:
            raise ObservationFailure('ss_invalid')
        inodes.add(int(matches[0]))
    return inodes

def empty_process(category='not_sampled'):
    return dict(status='unavailable', category=category, cpu_user_ticks=None, cpu_system_ticks=None,
                wchar=None, write_bytes=None, cancelled_write_bytes=None,
                io_status='unavailable', io_category=category)

class ReceiverTelemetry:
    def __init__(self, config, *, proc_root='/proc', ss_runner=None, listen_runner=None, filesystem=None, platform=None):
        self.config = dict(config) if isinstance(config, dict) else vars(config).copy()
        self.proc_root, self.fs = proc_root, filesystem or FileSystem()
        self.platform = platform or sys.platform
        self.stage = os.path.join(self.config['release_path'], '.runtime', 'releases',
                                 '%s-%s-%s' % (self.config['revision'], self.config['run_id'], self.config['attempt']))
        self.manifest = self.config['manifest']
        self.started = time.monotonic()
        self.queries = QueryProcesses()
        self.ss_runner = ss_runner or (lambda: self.queries.query(self.config['port']))
        self.listen_runner = listen_runner or (lambda: self.queries.query(self.config['port'], listening=True))

    def read(self, *parts, limit=PROC_LIMIT):
        return self.fs.read_text(os.path.join(self.proc_root, *map(str, parts)), limit=limit)

    def process(self, pid):
        match = re.fullmatch(r'([1-9][0-9]*) \((.*)\) (.*)', self.read(pid, 'stat').strip())
        fields = match[3].split() if match else []
        if len(fields) < 20 or int(match[1]) != pid:
            raise ObservationFailure('proc_invalid')
        if fields[0] in ('Z', 'X', 'x'):
            raise ObservationFailure('process_exited')
        try:
            values = [number(fields[index]) for index in (1, 19, 11, 12)]
            if any(value is None for value in values) or values[1] == 0:
                raise ValueError()
            return dict(zip(('pid', 'ppid', 'start', 'name', 'user', 'system'),
                            (pid, values[0], values[1], match[2], values[2], values[3])))
        except ValueError:
            raise ObservationFailure('proc_invalid') from None

    def process_metrics(self, process):
        result = empty_process()
        result.update(status='available', category='ok', cpu_user_ticks=process['user'], cpu_system_ticks=process['system'])
        try:
            text = self.read(process['pid'], 'io')
            for name in ('wchar', 'write_bytes', 'cancelled_write_bytes'):
                match = re.search(r'^' + name + r':\s+([0-9]+)$', text, re.M)
                result[name] = number(match[1]) if match else None
            valid = all(result[name] is not None for name in ('wchar', 'write_bytes', 'cancelled_write_bytes'))
            result.update(io_status='available' if valid else 'unavailable', io_category='ok' if valid else 'proc_invalid')
        except OSError as error:
            result['io_category'] = failure(error).category
        return result

    def pressure(self):
        result = dict(status='unavailable', category='io_missing', some_avg10_percent=None,
                      some_total_us=None, full_avg10_percent=None, full_total_us=None)
        try:
            text = self.read('pressure', 'io')
            for name in ('some', 'full'):
                line = re.search(r'^' + name + r' (.*)$', text, re.M)
                avg = re.search(r'(?:^|\s)avg10=([0-9]+(?:\.[0-9]+)?)(?=\s|$)', line[1]) if line else None
                total = re.search(r'(?:^|\s)total=([0-9]+)(?=\s|$)', line[1]) if line else None
                result[name + '_avg10_percent'] = float(avg[1]) if avg and float(avg[1]) <= 100 else None
                result[name + '_total_us'] = number(total[1]) if total else None
            valid = all(result[key] is not None for key in ('some_avg10_percent', 'some_total_us', 'full_avg10_percent', 'full_total_us'))
            result.update(status='available' if valid else 'unavailable', category='ok' if valid else 'io_invalid')
        except OSError as error:
            result['category'] = 'io_permission' if error.errno in (errno.EACCES, errno.EPERM) else 'io_missing'
        except ObservationFailure:
            result['category'] = 'io_invalid'
        return result

    def files(self):
        try:
            stage = self.fs.stat(self.stage, follow_symlinks=False)
        except FileNotFoundError:
            raise ObservationFailure('stage_missing') from None
        if not stat.S_ISDIR(stage.st_mode):
            raise ObservationFailure('stage_invalid')
        targets, sizes = {}, []
        for item in self.manifest:
            try:
                info = self.fs.stat(os.path.join(self.stage, item['name']), follow_symlinks=False)
            except FileNotFoundError:
                info = None
            if info and (not stat.S_ISREG(info.st_mode) or not 0 <= info.st_size <= item['bytes']):
                raise ObservationFailure('stage_invalid')
            sizes.append(dict(name=item['name'], expected_bytes=item['bytes'], received_bytes=info.st_size if info else 0))
            if info and item['name'] in ARCHIVES:
                targets[(info.st_dev, info.st_ino)] = info
        return stage, targets, sizes

    def fd_path(self, pid, fd):
        return os.path.join(self.proc_root, str(pid), 'fd', str(fd))

    def socket(self, pid, fd, inode):
        if self.fs.readlink(self.fd_path(pid, fd)) != 'socket:[%d]' % inode:
            raise ObservationFailure('socket_changed')

    def writable(self, pid, fd, inode):
        text = self.read(pid, 'fdinfo', fd)
        flags = re.search(r'^flags:\s+([0-7]+)$', text, re.M)
        identity = re.search(r'^ino:\s+([0-9]+)$', text, re.M)
        if not flags:
            raise ObservationFailure('proc_invalid')
        if int(flags[1], 8) & os.O_ACCMODE not in (os.O_WRONLY, os.O_RDWR):
            return False
        if not identity:
            raise ObservationFailure('proc_invalid')
        if int(identity[1]) != inode:
            raise ObservationFailure('file_changed')
        return True

    def listeners(self):
        return parse_listeners(self.listen_runner())

    def binding(self, targets):
        records, listeners, snapshots, writers = parse_sockets(self.ss_runner()), self.listeners(), {}, {}

        def snapshot(pid):
            # Cache discovery work, not the final identity checks of the selected binding.
            if pid in snapshots:
                return snapshots[pid]
            if len(snapshots) >= PID_LIMIT:
                raise ObservationFailure('proc_limit')
            snapshots[pid] = None
            try:
                process = self.process(pid)
                fds = self.fs.listdir(os.path.join(self.proc_root, str(pid), 'fd'), FD_LIMIT)
            except (FileNotFoundError, ProcessLookupError):
                return None
            except ObservationFailure as error:
                if error.category == 'process_exited':
                    return None
                raise
            try:
                children = self.read(pid, 'task', pid, 'children').split()
            except (FileNotFoundError, ProcessLookupError):
                try:
                    current = self.process(pid)
                except (FileNotFoundError, ProcessLookupError):
                    return None
                except ObservationFailure as error:
                    if error.category == 'process_exited':
                        return None
                    raise
                if any(current[key] != process[key] for key in ('start', 'ppid', 'name')):
                    raise ObservationFailure('process_changed')
                raise ObservationFailure('children_unavailable') from None
            if len(fds) > FD_LIMIT or len(children) > PID_LIMIT:
                raise ObservationFailure('proc_limit')
            if any(not re.fullmatch(r'[1-9][0-9]*', child) for child in children):
                raise ObservationFailure('proc_invalid')
            candidates, owns_listener = [], False
            for fd in fds:
                if not fd.isdigit():
                    raise ObservationFailure('proc_invalid')
                try:
                    link = self.fs.readlink(self.fd_path(pid, fd))
                    if re.fullmatch(r'socket:\[[0-9]+\]', link) and int(link[8:-1]) in listeners:
                        owns_listener = True
                    if not link.startswith('/'):
                        continue
                    info = self.fs.fstat_fd(self.fd_path(pid, fd))
                    if (info.st_dev, info.st_ino) in targets and self.writable(pid, fd, info.st_ino):
                        candidates.append((pid, int(fd), info.st_dev, info.st_ino))
                except (FileNotFoundError, ProcessLookupError):
                    # A completed status process or this collector's closed scandir FD.
                    continue
            value = (process, list(map(int, children)), candidates, owns_listener)
            snapshots[pid] = value
            return value

        pid_sockets = {}
        for record in records:
            for pid, _ in record['owners']:
                pid_sockets.setdefault(pid, set()).add(record['inode'])
        owners_seen = set()
        for record in records:
            for owner, socket_fd in record['owners']:
                identity = (record['inode'], owner)
                if identity in owners_seen:
                    continue
                owners_seen.add(identity)
                try:
                    self.socket(owner, socket_fd, record['inode'])
                except (FileNotFoundError, ProcessLookupError):
                    continue
                root = snapshot(owner)
                if root is None:
                    continue
                if root[0]['name'] not in ('sshd', 'sshd-session', 'sshd-auth', 'sftp-server', 'scp') or len(pid_sockets[owner]) != 1 or root[3]:
                    raise ObservationFailure('owner_shared')
                queue, seen = [(owner, None, 0, {})], set()
                while queue:
                    pid, parent, depth, ancestors = queue.pop()
                    if pid in seen or depth > DEPTH_LIMIT:
                        raise ObservationFailure('proc_limit')
                    seen.add(pid)
                    value = snapshot(pid)
                    if value is None:
                        continue
                    process, children, candidates, _ = value
                    if parent is not None and process['ppid'] != parent:
                        continue
                    chain = {**ancestors, pid: process}
                    for key in candidates:
                        writers.setdefault(key, []).append((record, owner, socket_fd, chain))
                    queue.extend((child, pid, depth + 1, chain) for child in children)
        if len(writers) != 1:
            raise ObservationFailure('writer_ambiguous' if writers else 'writer_unavailable')
        writer, bindings = next(iter(writers.items()))
        if len({record['inode'] for record, _, _, _ in bindings}) != 1:
            raise ObservationFailure('socket_ambiguous')
        # The closest actual connection owner avoids attributing work to its shared ancestors.
        binding = next((item for item in bindings if item[1] == writer[0]), bindings[0])
        return writer, binding[:3], binding[3]

    def sample(self):
        output = dict(schema=1, event='receiver_telemetry', revision=self.config['revision'],
                      run_id=self.config['run_id'], attempt=self.config['attempt'],
                      elapsed_ms=round((time.monotonic() - self.started) * 1000),
                      utc=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
                      status='unavailable', category='not_sampled', identifiers=dict.fromkeys(IDENTIFIERS),
                      tcp=dict.fromkeys(TCP_FIELDS), processes={'writer': empty_process(), 'connection': empty_process()},
                      io_pressure=self.pressure(), files=[dict(name=i['name'], expected_bytes=i['bytes'], received_bytes=None) for i in self.manifest],
                      total_bytes=sum(i['bytes'] for i in self.manifest), received_bytes=None, remaining_bytes=None)
        if self.platform != 'linux':
            return dict(output, category='platform_unsupported')
        try:
            if self.queries.stop.is_set():
                raise ObservationFailure('cancelled')
            stage, targets, _ = self.files()
            writer, (record, owner, socket_fd), nodes = self.binding(targets)
            pid, fd, device, inode = writer
            processes = {'writer': self.process_metrics(nodes[pid]), 'connection': self.process_metrics(nodes[owner])}
            for ident, previous in nodes.items():
                current = self.process(ident)
                if any(current[key] != previous[key] for key in ('start', 'ppid', 'name')):
                    raise ObservationFailure('process_changed')
            if not self.writable(pid, fd, inode):
                raise ObservationFailure('file_changed')
            info = self.fs.fstat_fd(self.fd_path(pid, fd))
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino) != (device, inode):
                raise ObservationFailure('file_changed')
            self.socket(owner, socket_fd, record['inode'])
            after, current_targets, sizes = self.files()
            if (stage.st_dev, stage.st_ino) != (after.st_dev, after.st_ino):
                raise ObservationFailure('stage_changed')
            if (device, inode) not in current_targets:
                raise ObservationFailure('file_changed')
            if self.queries.stop.is_set():
                raise ObservationFailure('cancelled')
            received = sum(item['received_bytes'] for item in sizes)
            output.update(status='available', category='ok', tcp=record['metrics'], files=sizes, processes=processes,
                          received_bytes=received, remaining_bytes=output['total_bytes'] - received,
                          identifiers=dict(zip(IDENTIFIERS, (pid, nodes[pid]['start'], fd, inode,
                                           stage.st_ino, record['inode'], owner, nodes[owner]['start'], socket_fd))))
        except ObservationFailure as error:
            output['category'] = error.category
        except OSError as error:
            output['category'] = failure(error).category
        except Exception:
            output['category'] = 'unexpected_error'
        return output

def parse_config(argv=None):
    class SafeParser(argparse.ArgumentParser):
        def error(self, _message):
            self.exit(2, 'receiver configuration_invalid\n')
    parser = SafeParser(description='Read-only receiver telemetry for one fixed release.')
    for name in ('release-path', 'revision', 'run-id', 'attempt', 'port', 'manifest-json', 'job-started-at'):
        parser.add_argument('--' + name, required=True)
    for name, default in [('duration-seconds', MAX_SECONDS), ('sample-interval-seconds', SAMPLE_SECONDS), ('discovery-interval-seconds', 1)]:
        parser.add_argument('--' + name, type=float, default=default)
    config = vars(parser.parse_args(argv))
    try:
        path = config['release_path']
        if not os.path.isabs(path) or path == '/' or os.path.normpath(path) != path or not re.fullmatch(r'[0-9a-f]{40}', config['revision']):
            raise ValueError()
        for name in ('run_id', 'attempt', 'port'):
            if not re.fullmatch(r'[1-9][0-9]*', config[name]):
                raise ValueError()
            config[name] = int(config[name])
            if config[name] > MAX_INTEGER:
                raise ValueError()
        if config['port'] > 65535:
            raise ValueError()
        for name, maximum in [('duration_seconds', MAX_SECONDS), ('sample_interval_seconds', SAMPLE_SECONDS), ('discovery_interval_seconds', 1)]:
            if not math.isfinite(config[name]) or not 0 < config[name] <= maximum:
                raise ValueError()
        manifest = json.loads(config.pop('manifest_json'))
        if not isinstance(manifest, list) or len(manifest) != len(FILES) or {item['name'] for item in manifest} != set(FILES):
            raise ValueError()
        for item in manifest:
            if set(item) - {'name', 'bytes', 'sha256'} or type(item['bytes']) is not int or not 0 <= item['bytes'] <= MAX_INTEGER:
                raise ValueError()
            if 'sha256' in item and not re.fullmatch(r'[0-9a-f]{64}', item['sha256']):
                raise ValueError()
        config['manifest'] = sorted(manifest, key=lambda item: FILES.index(item['name']))
        if sum(item['bytes'] for item in manifest) > MAX_INTEGER:
            raise ValueError()
        started = datetime.datetime.fromisoformat(config['job_started_at'].replace('Z', '+00:00'))
        if started.tzinfo is None or started.utcoffset() != datetime.timedelta(0):
            raise ValueError()
        config['deadline_seconds'] = max(0, min(config['duration_seconds'], started.timestamp() + MAX_SECONDS - time.time()))
    except (ValueError, TypeError, KeyError, OverflowError):
        parser.error('invalid receiver configuration')
    return config

def main(argv=None):
    config, stop, finished = parse_config(argv), threading.Event(), threading.Event()
    collector = ReceiverTelemetry(config)
    collector.queries.stop = stop
    deadline, lock = time.monotonic() + config['deadline_seconds'], threading.RLock()
    state = {'count': 0, 'bytes': 0, 'complete': False, 'reason': 'deadline', 'finalized': False, 'exit_code': 1}

    def emit(value, final=False):
        encoded = json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n'
        with lock:
            if state['complete'] or (not final and (state['count'] >= OUTPUT_COUNT - 1 or state['bytes'] + len(encoded) > OUTPUT_BYTES - 4096)):
                return False
            try:
                sys.stdout.write(encoded)
                sys.stdout.flush()
            except (BrokenPipeError, OSError):
                stop.set()
                return False
            state['count'] += 1
            state['bytes'] += len(encoded)
            state['complete'] = final
        return True

    def complete(reason):
        with lock:
            if state['finalized']:
                return state['exit_code']
            state['finalized'] = True
            cleanup = collector.queries.cleanup()
            children = collector.queries.children_active()
            emit(dict(schema=1, event='receiver_complete', revision=config['revision'], run_id=config['run_id'],
                      attempt=config['attempt'], elapsed_ms=round((time.monotonic() - collector.started) * 1000),
                      utc=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
                      reason=reason, children_active=children,
                      cleanup='confirmed' if cleanup and not children else 'unconfirmed'), final=True)
            state['exit_code'] = 0 if cleanup and not children and reason != 'unexpected_error' else 1
            return state['exit_code']

    def watchdog():
        # Signals and normal cleanup wake the same single watchdog as the deadline.
        stop.wait(max(0, deadline - time.monotonic()))
        stop.set()
        if not finished.wait(2 * STOP_SECONDS + 1):
            # A blocked filesystem or stdout must not defeat the monotonic deadline.
            def force_exit():
                if not finished.wait(2 * STOP_SECONDS + 1):
                    os._exit(1)
            threading.Thread(target=force_exit, daemon=True).start()
            complete(state['reason'])
            os._exit(1)

    def request_stop(_signum, _frame):
        state['reason'] = 'signal'
        stop.set()

    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, request_stop)
    threading.Thread(target=watchdog, daemon=True).start()
    next_output, previous = 0, None
    try:
        while not stop.is_set() and time.monotonic() < deadline:
            sample = collector.sample()
            now, signature = time.monotonic(), (sample['status'], sample['category'])
            if now >= next_output or signature != previous:
                if not emit(sample):
                    state['reason'] = 'output_limit'
                    break
                next_output, previous = now + config['sample_interval_seconds'], signature
            if sample['category'] in ('ss_missing', 'platform_unsupported', 'cleanup_unconfirmed'):
                state['reason'] = 'unavailable'
                break
            interval = config['sample_interval_seconds'] if sample['status'] == 'available' or now - collector.started >= 60 else config['discovery_interval_seconds']
            stop.wait(min(interval, max(0, deadline - time.monotonic())))
    except Exception:
        state['reason'] = 'unexpected_error'
    finally:
        stop.set()
        code = complete(state['reason'])
        finished.set()
    return code

if __name__ == '__main__':
    sys.exit(main())
