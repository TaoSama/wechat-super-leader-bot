"""Receiver observation contracts using synthetic Linux procfs and socket output."""

import copy
import errno
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import unittest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "receiver_telemetry", ROOT / "scripts/deploy/receiver-telemetry.py")
receiver = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = receiver
SPEC.loader.exec_module(receiver)

SECRET = "SYNTHETIC_SECRET_https://private.invalid/token"
PROC = "/synthetic/proc"
RELEASE = "/srv/private-deploy"
REVISION = "a" * 40
NAMES = ["controller.tar", "gateway.tar", "release.sha256", "manifest.env",
         "compose.release.yaml", "compose.yaml", "compose.production.yaml",
         "compose.gateway.yaml", "codex-seccomp.json", "remote-release.sh", "release-state.py"]
CONFIG = {"release_path": RELEASE, "revision": REVISION, "run_id": "123",
          "attempt": "2", "port": 22,
          "manifest": [{"name": name, "bytes": 1000} for name in NAMES],
          "job_started_at": "2026-11-03T00:00:00Z"}
CONFIG_ARGS = [part for key, value in CONFIG.items() if key != "manifest"
               for part in ["--" + key.replace("_", "-"), str(value)]]
CONFIG_ARGS += ["--manifest-json", json.dumps(CONFIG["manifest"])]
STAGE = f"{RELEASE}/.runtime/releases/{REVISION}-123-2"
ARCHIVE = f"{STAGE}/controller.tar"
SOCKET = 123456
SESSION = 200
WRITER = 201
IO = "wchar: 42000\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n"
PRESSURE = ("some avg10=1.25 avg60=0.30 avg300=0.10 total=1234\n"
            "full avg10=0.25 avg60=0.10 avg300=0.01 total=321\n")


def inode(number, *, device=7, size=123, mode=stat.S_IFREG | 0o600):
    return os.stat_result((mode, number, device, 1, 1000, 1000, size, 0, 0, 0))


def process_stat(pid, name, parent, *, start=999, user=30, system=7):
    fields = ["0"] * 50
    fields[0], fields[1], fields[2] = "S", str(parent), str(parent)
    fields[11], fields[12], fields[19] = str(user), str(system), str(start)
    return f"{pid} ({name}) {' '.join(fields)}\n"


def socket_line(owners=((SESSION, 3),), *, socket_inode=SOCKET, received=42000,
                extra="", state="ESTAB"):
    users = ",".join(f'("sshd-session",pid={pid},fd={fd})' for pid, fd in owners)
    return (f"{state} 17 0 203.0.113.11:22 198.51.100.22:32123 "
            f"users:({users}) ino:{socket_inode} "
            "skmem:(r10,rb20,t3,tb4,f5,w6,o7,bl8,d9)\n"
            f"\t cubic bytes_received:{received} rcv_space:65000 "
            f"rcv_ssthresh:40000 {extra}\n")


class SyntheticFS:
    def __init__(self):
        self.text, self.links, self.stats, self.fds, self.dirs = {}, {}, {}, {}, {}
        self.calls = []
        self.hook = None

    def lookup(self, operation, values, path, limit=None):
        self.calls.append((operation, path, limit))
        if self.hook:
            self.hook(operation, path)
        value = values.get(path, FileNotFoundError(errno.ENOENT, SECRET))
        if isinstance(value, BaseException):
            raise value
        return value() if callable(value) else value

    def read_text(self, path, limit=8192):
        return self.lookup("read", self.text, path, limit)

    def listdir(self, path, limit):
        values = list(self.lookup("list", self.dirs, path, limit))
        if len(values) > limit:
            raise receiver.ObservationFailure("proc_limit")
        return values

    def readlink(self, path):
        return self.lookup("link", self.links, path)

    def stat(self, path, follow_symlinks=False):
        return self.lookup("stat", self.stats, path)

    def fstat_fd(self, path):
        return self.lookup("fstat", self.fds, path)


class Fixture:
    def __init__(self):
        self.fs = SyntheticFS()
        self.ss = socket_line()
        self.listen = "LISTEN 0 128 0.0.0.0:22 0.0.0.0:* ino:900\n"
        self.ss_calls = 0
        self.before_ss = None
        self.fs.stats[STAGE] = inode(500, mode=stat.S_IFDIR | 0o700)
        for index, name in enumerate(NAMES):
            self.fs.stats[f"{STAGE}/{name}"] = inode(1000 + index, size=123)
        self.fs.text[f"{PROC}/pressure/io"] = PRESSURE
        self.fs.dirs[PROC] = []
        self.process(100, "sshd", 1, children=[SESSION])
        self.process(SESSION, "sshd-session", 100, children=[WRITER])
        self.process(WRITER, "sftp-server", SESSION)
        self.socket(100, 3, 900)
        self.socket(SESSION, 3, SOCKET)
        self.file(WRITER, 4)
        self.telemetry = receiver.ReceiverTelemetry(
            copy.deepcopy(CONFIG), proc_root=PROC, ss_runner=self.run_ss, listen_runner=self.run_listen,
            filesystem=self.fs, platform="linux")

    def process(self, pid, name, parent, *, children=(), start=999):
        if str(pid) not in self.fs.dirs[PROC]:
            self.fs.dirs[PROC].append(str(pid))
        self.fs.text[f"{PROC}/{pid}/stat"] = process_stat(pid, name, parent, start=start)
        self.fs.text[f"{PROC}/{pid}/io"] = IO
        self.fs.text[f"{PROC}/{pid}/task/{pid}/children"] = " ".join(map(str, children))
        self.fs.dirs.setdefault(f"{PROC}/{pid}/fd", [])

    def socket(self, pid, fd, number):
        self.fs.links[f"{PROC}/{pid}/fd/{fd}"] = f"socket:[{number}]"
        self.fs.dirs[f"{PROC}/{pid}/fd"].append(str(fd))

    def file(self, pid, fd, *, path=ARCHIVE, flags="0100001", info_inode=None):
        self.fs.links[f"{PROC}/{pid}/fd/{fd}"] = path
        self.fs.fds[f"{PROC}/{pid}/fd/{fd}"] = self.fs.stats[path]
        self.fs.text[f"{PROC}/{pid}/fdinfo/{fd}"] = (
            f"pos:\t123\nflags:\t{flags}\nmnt_id:\t23\n"
            f"ino:\t{info_inode or self.fs.stats[path].st_ino}\n")
        self.fs.dirs[f"{PROC}/{pid}/fd"].append(str(fd))

    def run_ss(self):
        self.ss_calls += 1
        if self.before_ss:
            self.before_ss()
        if isinstance(self.ss, BaseException):
            raise self.ss
        return self.ss

    def run_listen(self):
        if isinstance(self.listen, BaseException):
            raise self.listen
        return self.listen

class ReceiverAssertions:
    def setUp(self):
        self.f = Fixture()

    def sample(self):
        result = self.f.telemetry.sample()
        encoded = json.dumps(result)
        for forbidden in [SECRET, RELEASE, PROC, "203.0.113", "198.51.100", "private.invalid"]:
            self.assertNotIn(forbidden, encoded)
        return result

    def unavailable(self, category=None):
        output = self.sample()
        self.assertEqual(output["status"], "unavailable")
        if category:
            self.assertEqual(output["category"], category)
        self.assertTrue(all(value is None for value in output["tcp"].values()))
        return output

class ReceiverTelemetryTests(ReceiverAssertions, unittest.TestCase):
    def test_writer_and_unique_session_socket_are_bound(self):
        output = self.sample()
        self.assertEqual(output["status"], "available")
        self.assertEqual(output["category"], "ok")
        self.assertEqual(output["identifiers"]["writer_pid"], WRITER)
        self.assertEqual(output["identifiers"]["owner_pid"], SESSION)
        self.assertEqual(output["identifiers"]["file_fd"], 4)
        self.assertEqual(output["identifiers"]["file_inode"], 1000)
        self.assertEqual(output["identifiers"]["stage_inode"], 500)
        self.assertEqual(output["identifiers"]["socket_inode"], SOCKET)
        self.assertEqual(output["tcp"], {"bytes_received": 42000, "recv_queue_bytes": 17,
                         "rcv_space_bytes": 65000, "rcv_ssthresh_bytes": 40000,
                         "receive_memory_bytes": 10, "receive_buffer_bytes": 20,
                         "backlog_bytes": 8, "drops": 9})
        self.assertEqual(output["processes"]["writer"]["cpu_user_ticks"], 30)
        self.assertEqual(output["processes"]["writer"]["write_bytes"], 8192)
        self.assertEqual(output["io_pressure"]["some_total_us"], 1234)

    def test_octal_access_mode_accepts_write_and_read_write(self):
        for flags in ["0100001", "0100002", "02001001"]:
            with self.subTest(flags=flags):
                self.f.fs.text[f"{PROC}/{WRITER}/fdinfo/4"] = f"flags:\t{flags}\nino:\t1000\n"
                self.assertEqual(self.sample()["status"], "available")

    def test_read_only_or_stat_only_status_cannot_anchor_writer(self):
        for flags in ["0100000", "00", "0100008", "", "-1"]:
            with self.subTest(flags=flags):
                self.f.fs.text[f"{PROC}/{WRITER}/fdinfo/4"] = f"flags:\t{flags}\nino:\t1000\n"
                self.unavailable()
        self.f.fs.dirs[f"{PROC}/{WRITER}/fd"] = []
        self.unavailable("writer_unavailable")

    def test_parallel_status_session_and_read_only_verify_are_not_upload(self):
        self.f.process(300, "sshd-session", 100, children=[301])
        self.f.process(301, "python3", 300)
        self.f.socket(300, 3, 999999)
        self.f.file(301, 4, flags="0100000")
        self.f.ss += socket_line(((300, 3),), socket_inode=999999, received=999999)
        output = self.sample()
        self.assertEqual(output["status"], "available")
        self.assertEqual(output["identifiers"]["owner_pid"], SESSION)
        self.assertEqual(output["tcp"]["bytes_received"], 42000)

    def test_same_socket_shared_by_related_owners_is_deduplicated(self):
        self.f.socket(WRITER, 3, SOCKET)
        self.f.ss = socket_line(((SESSION, 3), (WRITER, 3)))
        self.assertEqual(self.sample()["status"], "available")

    def test_duplicate_socket_fds_and_related_owners_share_global_scan_budget(self):
        for related_owner in [False, True]:
            with self.subTest(related_owner=related_owner):
                self.f = Fixture()
                owners = [(SESSION, 3)]
                for fd in range(10, 137):
                    self.f.socket(SESSION, fd, SOCKET)
                    owners.append((SESSION, fd))
                if related_owner:
                    self.f.process(202, "sshd-session", SESSION, children=[WRITER])
                    self.f.fs.text[f"{PROC}/{SESSION}/task/{SESSION}/children"] = "202"
                    self.f.fs.text[f"{PROC}/{WRITER}/stat"] = process_stat(WRITER, "sftp-server", 202)
                    self.f.socket(WRITER, 3, SOCKET)
                    owners.append((WRITER, 3))
                self.f.ss = socket_line(tuple(owners))
                output = self.sample()
                self.assertEqual(output["status"], "available")
                self.assertEqual(output["identifiers"]["writer_pid"], WRITER)
                self.assertEqual(output["identifiers"]["socket_inode"], SOCKET)
                scans = [path for operation, path, _ in self.f.fs.calls if operation == "list"]
                with self.subTest(resource="fd_directories"):
                    self.assertLessEqual(len(scans), 64)
                    self.assertEqual(len(scans), len(set(scans)), "each PID FD directory is scanned once")
                with self.subTest(resource="readlinks"):
                    links = sum(operation == "link" for operation, _, _ in self.f.fs.calls)
                    self.assertLessEqual(links, 64 * 128 + 2)

    def test_distinct_upload_sockets_are_ambiguous(self):
        self.f.socket(SESSION, 5, 654321)
        self.f.ss += socket_line(((SESSION, 5),), socket_inode=654321)
        self.unavailable()

    def test_multiple_actual_writers_are_ambiguous(self):
        self.f.process(202, "sftp-server", SESSION)
        self.f.fs.text[f"{PROC}/{SESSION}/task/{SESSION}/children"] = f"{WRITER} 202"
        self.f.file(202, 4, path=f"{STAGE}/gateway.tar")
        self.unavailable("writer_ambiguous")

    def test_stage_file_device_and_inode_must_both_match_fd(self):
        for changed in [inode(1000, device=8), inode(9999)]:
            with self.subTest(changed=changed):
                self.f.fs.fds[f"{PROC}/{WRITER}/fd/4"] = changed
                self.unavailable()

    def test_fdinfo_inode_must_match_fstat_before_and_after_metrics(self):
        mismatched = "flags:\t0100001\nino:\t9999\n"
        for during_metrics in [False, True]:
            with self.subTest(during_metrics=during_metrics):
                self.f = Fixture()
                mutate = lambda: self.f.fs.text.update({f"{PROC}/{WRITER}/fdinfo/4": mismatched})
                if during_metrics:
                    self.mutate_during_metrics(mutate)
                else:
                    mutate()
                output = self.unavailable("file_changed")
                self.assertTrue(all(value is None for value in output["identifiers"].values()))

    def test_stage_symlinks_and_nonregular_archive_are_rejected(self):
        for path, changed in [(STAGE, inode(500, mode=stat.S_IFLNK | 0o700)),
                              (ARCHIVE, inode(1000, mode=stat.S_IFDIR | 0o700))]:
            with self.subTest(path=path):
                self.f = Fixture()
                self.f.fs.stats[path] = changed
                self.unavailable("stage_invalid")

    def test_unrelated_open_file_and_old_stage_cannot_anchor(self):
        self.f.fs.links[f"{PROC}/{WRITER}/fd/4"] = ARCHIVE.replace("-123-2", "-122-2")
        self.f.fs.fds[f"{PROC}/{WRITER}/fd/4"] = inode(9999)
        self.unavailable("writer_unavailable")

    def test_listener_daemon_does_not_join_unrelated_session(self):
        self.f.ss = socket_line(((100, 3),), socket_inode=900)
        self.unavailable()

    def test_permission_failure_is_observable_and_private(self):
        self.f.fs.text[f"{PROC}/{WRITER}/fdinfo/4"] = PermissionError(errno.EACCES, SECRET)
        self.unavailable("proc_permission")

    def test_missing_optional_process_io_is_null_without_losing_binding(self):
        self.f.fs.text[f"{PROC}/{WRITER}/io"] = PermissionError(errno.EACCES, SECRET)
        output = self.sample()
        self.assertEqual(output["status"], "available")
        process = output["processes"]["writer"]
        self.assertIsNone(process["wchar"])
        self.assertIsNone(process["write_bytes"])
        self.assertNotEqual(process["io_category"], "ok")

    def test_missing_optional_tcp_and_pressure_fields_are_null(self):
        self.f.ss = socket_line().replace("bytes_received:42000", "bytes_received:NaN")
        self.f.fs.text[f"{PROC}/pressure/io"] = "some avg10=1.25 total=1234\n"
        output = self.sample()
        self.assertEqual(output["status"], "available")
        self.assertIsNone(output["tcp"]["bytes_received"])
        self.assertIsNone(output["io_pressure"]["full_avg10_percent"])

    def test_tool_failures_have_fixed_categories_without_raw_stderr(self):
        for category in ["ss_missing", "ss_timeout", "ss_output_limit", "ss_failed"]:
            with self.subTest(category=category):
                self.f.ss = receiver.ObservationFailure(category)
                self.unavailable(category)

    def test_plain_tool_exception_is_observable(self):
        self.f.ss = RuntimeError(SECRET)
        self.unavailable("unexpected_error")

    def test_ss_output_is_bounded(self):
        self.f.ss = "x" * (64 * 1024 + 1)
        self.unavailable("ss_output_limit")

    def test_candidate_socket_count_is_bounded(self):
        self.f.ss = "".join(socket_line(((SESSION, 3),), socket_inode=SOCKET + index)
                            for index in range(17))
        self.unavailable()

    def test_fd_scan_is_bounded(self):
        self.f.fs.dirs[f"{PROC}/{WRITER}/fd"] = [str(fd) for fd in range(129)]
        self.unavailable("proc_limit")
        reads = [path for operation, path, _ in self.f.fs.calls if operation == "link"]
        self.assertLessEqual(len(reads), 129)

    def test_process_tree_scan_is_bounded(self):
        self.f.fs.text[f"{PROC}/{SESSION}/task/{SESSION}/children"] = " ".join(map(str, range(201, 266)))
        for pid in range(202, 266):
            self.f.process(pid, "python3", SESSION)
        self.unavailable("proc_limit")

    def test_unsupported_platform_never_runs_ss(self):
        self.f.telemetry = receiver.ReceiverTelemetry(CONFIG, filesystem=self.f.fs,
                                                     ss_runner=self.f.run_ss, platform="darwin")
        self.unavailable("platform_unsupported")
        self.assertEqual(self.f.ss_calls, 0)

    def mutate_during_metrics(self, mutation):
        def hook(operation, path):
            if operation == "read" and path == f"{PROC}/{WRITER}/io":
                self.f.fs.hook = None
                mutation()
        self.f.fs.hook = hook

    def test_pid_start_time_and_parent_races_invalidate_binding(self):
        for pid, parent in [(WRITER, SESSION), (SESSION, 100)]:
            name = "sftp-server" if pid == WRITER else "sshd-session"
            for changed in [process_stat(pid + 1, name, parent),
                            process_stat(pid, name, parent, start=1000),
                            process_stat(pid, name, parent + 1)]:
                with self.subTest(pid=pid, changed=changed):
                    self.f = Fixture()
                    self.mutate_during_metrics(lambda: self.f.fs.text.update({f"{PROC}/{pid}/stat": changed}))
                    self.unavailable()

    def test_process_exit_during_snapshot_invalidates_binding(self):
        self.mutate_during_metrics(lambda: self.f.fs.text.pop(f"{PROC}/{WRITER}/stat"))
        self.unavailable("process_exited")

    def test_failed_identity_recheck_discards_unbound_process_metrics(self):
        def mutate():
            self.f.fs.text[f"{PROC}/{WRITER}/stat"] = process_stat(WRITER, "sftp-server", SESSION, start=1000)
            self.f.fs.text[f"{PROC}/{WRITER}/io"] = "wchar: 999999\nwrite_bytes: 999999\ncancelled_write_bytes: 0\n"
        self.mutate_during_metrics(mutate)
        output = self.unavailable("process_changed")
        self.assertTrue(all(value is None for value in output["identifiers"].values()))
        for process in output["processes"].values():
            self.assertEqual(process["status"], "unavailable")
            self.assertEqual(process["io_status"], "unavailable")
            for field in ["cpu_user_ticks", "cpu_system_ticks", "wchar", "write_bytes", "cancelled_write_bytes"]:
                self.assertIsNone(process[field], field)
        self.assertEqual(output["io_pressure"]["status"], "available")

    def test_file_fd_reuse_or_access_mode_change_invalidates_binding(self):
        for changed in [inode(1001), inode(1000, device=8),
                        inode(1000, mode=stat.S_IFDIR | 0o700)]:
            with self.subTest(changed=changed):
                self.f = Fixture()
                self.mutate_during_metrics(lambda: self.f.fs.fds.update({f"{PROC}/{WRITER}/fd/4": changed}))
                self.unavailable("file_changed")
        self.f = Fixture()
        self.mutate_during_metrics(lambda: self.f.fs.text.update({f"{PROC}/{WRITER}/fdinfo/4": "flags: 0100000\n"}))
        self.unavailable("file_changed")

    def test_socket_fd_reuse_during_snapshot_invalidates_binding(self):
        self.mutate_during_metrics(lambda: self.f.fs.links.update({f"{PROC}/{SESSION}/fd/3": "socket:[654321]"}))
        self.unavailable("socket_changed")

    def test_stage_device_and_inode_races_invalidate_binding(self):
        for changed in [inode(501, mode=stat.S_IFDIR | 0o700),
                        inode(500, device=8, mode=stat.S_IFDIR | 0o700)]:
            with self.subTest(changed=changed):
                self.f = Fixture()
                self.mutate_during_metrics(lambda: self.f.fs.stats.update({STAGE: changed}))
                self.unavailable("stage_changed")

    def test_replaced_stage_archive_invalidates_binding(self):
        self.mutate_during_metrics(lambda: self.f.fs.stats.update({ARCHIVE: inode(9999)}))
        self.unavailable("file_changed")

    def test_bound_socket_can_continue_into_second_archive(self):
        first = self.sample()
        self.assertEqual(first["status"], "available")
        self.f.fs.dirs[f"{PROC}/{WRITER}/fd"] = []
        self.f.file(WRITER, 6, path=f"{STAGE}/gateway.tar")
        second = self.sample()
        self.assertEqual(second["status"], "available")
        self.assertEqual(second["identifiers"]["socket_inode"], first["identifiers"]["socket_inode"])
        self.assertEqual(second["identifiers"]["file_fd"], 6)
        self.assertEqual(second["identifiers"]["file_inode"], 1001)

    def test_writer_gap_never_substitutes_read_only_status_socket(self):
        self.assertEqual(self.sample()["status"], "available")
        self.f.fs.dirs[f"{PROC}/{WRITER}/fd"] = []
        self.f.process(300, "sshd-session", 100, children=[301])
        self.f.process(301, "python3", 300)
        self.f.socket(300, 3, 999999)
        self.f.file(301, 4, flags="0100000")
        self.f.ss += socket_line(((300, 3),), socket_inode=999999)
        self.unavailable("writer_unavailable")

    def test_payload_progress_is_manifest_bounded_and_separate_from_tcp_bytes(self):
        output = self.sample()
        self.assertEqual(output["total_bytes"], len(NAMES) * 1000)
        self.assertEqual(output["received_bytes"], len(NAMES) * 123)
        self.assertEqual(output["remaining_bytes"], len(NAMES) * (1000 - 123))
        self.assertEqual(len(output["files"]), len(NAMES))
        self.f.fs.stats[ARCHIVE] = inode(1000, size=1001)
        self.unavailable("stage_invalid")

    def test_missing_stage_does_not_scan_connections(self):
        self.f.fs.stats.pop(STAGE)
        self.unavailable("stage_missing")
        self.assertEqual(self.f.ss_calls, 0)

    def test_descendant_depth_is_bounded(self):
        self.f.fs.text[f"{PROC}/{SESSION}/task/{SESSION}/children"] = "202"
        for pid in range(202, 219):
            self.f.process(pid, "python3", SESSION if pid == 202 else pid - 1,
                           children=[pid + 1] if pid < 218 else [WRITER])
        self.f.fs.text[f"{PROC}/{WRITER}/stat"] = process_stat(WRITER, "sftp-server", 218)
        self.unavailable("proc_limit")

    def test_scan_uses_only_bounded_related_process_directories(self):
        self.assertEqual(self.sample()["status"], "available")
        lists = [(path, limit) for operation, path, limit in self.f.fs.calls if operation == "list"]
        self.assertTrue(lists)
        self.assertTrue(all(path != PROC and limit <= 128 for path, limit in lists))

    def test_closed_scandir_fd_in_observer_branch_does_not_hide_upload(self):
        self.f.process(400, "sshd-session", 100, children=[401])
        self.f.process(401, "python3", 400)
        self.f.socket(400, 3, 888888)
        self.f.fs.dirs[f"{PROC}/401/fd"] = ["8"]
        self.f.fs.links[f"{PROC}/401/fd/8"] = FileNotFoundError(errno.ENOENT, SECRET)
        self.f.ss += socket_line(((400, 3),), socket_inode=888888)
        self.assertEqual(self.sample()["status"], "available")

    def test_unrelated_status_exit_during_or_after_discovery_does_not_hide_upload(self):
        for during_discovery in [True, False]:
            with self.subTest(during_discovery=during_discovery):
                self.f = Fixture()
                self.f.process(300, "sshd-session", 100, children=[301])
                self.f.process(301, "python3", 300)
                self.f.socket(300, 3, 999999)
                self.f.file(301, 4, flags="0100000")
                self.f.ss += socket_line(((300, 3),), socket_inode=999999)
                if during_discovery:
                    self.f.fs.text[f"{PROC}/301/stat"] = FileNotFoundError(errno.ENOENT, SECRET)
                else:
                    self.mutate_during_metrics(lambda: self.f.fs.text.pop(f"{PROC}/301/stat"))
                self.assertEqual(self.sample()["status"], "available")

class ManifestLayoutTests(unittest.TestCase):
    def parse_manifest(self, manifest):
        args = CONFIG_ARGS[:]
        args[args.index("--manifest-json") + 1] = json.dumps(manifest)
        return receiver.parse_config(args)

    def test_current_and_historical_layouts_are_accepted_for_passive_observation(self):
        for manifest in [CONFIG["manifest"],
                         [item for item in CONFIG["manifest"] if item["name"] != "release-state.py"]]:
            with self.subTest(files=len(manifest)):
                result = self.parse_manifest(list(reversed(manifest)))
                self.assertEqual(result["manifest"], manifest)

    def test_other_subsets_duplicates_and_unknown_names_are_rejected(self):
        original = CONFIG["manifest"]
        invalid = [
            [item for item in original if item["name"] != "compose.yaml"],
            original[:-2],
            original[:-1] + [original[0]],
            original[:-1] + [{"name": "untrusted.py", "bytes": 1000}],
        ]
        for manifest in invalid:
            with self.subTest(names=[item["name"] for item in manifest]):
                with self.assertRaises(SystemExit) as error:
                    self.parse_manifest(manifest)
                self.assertEqual(error.exception.code, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
