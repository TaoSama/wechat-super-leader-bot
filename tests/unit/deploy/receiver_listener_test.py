"""Target-port listener queries and procfs discovery identity contracts."""

import errno
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import receiver_telemetry_test as telemetry
from receiver_telemetry_test import SECRET, receiver


class ReceiverDiscoveryTests(telemetry.ReceiverAssertions, unittest.TestCase):
    def test_large_unrelated_tcp_table_is_never_read(self):
        table = "header\n" + ("unrelated TCP connection".ljust(149) + "\n") * 450
        self.assertEqual(len(table.encode()), 67507)
        self.f.fs.text[f"{telemetry.PROC}/net/tcp"] = table
        def reject_table_reads(operation, path):
            if operation == "read" and path.startswith(f"{telemetry.PROC}/net/tcp"):
                self.fail("listener discovery must not read the host-wide TCP table")
        self.f.fs.hook = reject_table_reads
        self.assertEqual(self.sample()["status"], "available")

    def test_listener_inode_without_owner_fields_can_guard_binding(self):
        self.f.listen = "0 128 0.0.0.0:22 0.0.0.0:* ino:900\n"
        self.assertEqual(self.sample()["status"], "available")
        self.f.socket(telemetry.SESSION, 99, 900)
        self.unavailable("owner_shared")

    def test_listener_query_failures_are_fixed_and_leave_no_bound_metrics(self):
        failures = [(receiver.ObservationFailure(category), category) for category in
                    ["ss_missing", "ss_timeout", "ss_output_limit", "ss_failed"]]
        failures += [(RuntimeError(SECRET), "unexpected_error")]
        for error, category in failures:
            with self.subTest(category=category):
                self.f.listen = error
                output = self.unavailable(category)
                self.assertTrue(all(value is None for value in output["identifiers"].values()))
                self.assertTrue(all(value["status"] == "unavailable" for value in output["processes"].values()))

    def test_malformed_or_missing_listener_inode_never_becomes_zero(self):
        for text, category in [(SECRET, "ss_invalid"), ("0 128 0.0.0.0:22 0.0.0.0:*\n", "ss_invalid"),
            ("LISTEN 0 128 0.0.0.0:22 0.0.0.0:* ino:0\n", "ss_invalid"), ("x" * 65537, "ss_output_limit"),
            ("0 128 0.0.0.0:22 0.0.0.0:* ino:900\n" * 17, "proc_limit")]:
            with self.subTest(text=text[:80]):
                self.f.listen = text
                output = self.unavailable(category)
                self.assertIsNone(output["identifiers"]["socket_inode"])

    def test_missing_children_for_unchanged_live_pid_is_observation_failure(self):
        self.f.fs.text.pop(f"{telemetry.PROC}/{telemetry.WRITER}/task/{telemetry.WRITER}/children")
        self.unavailable("children_unavailable")

    def test_missing_children_for_real_exit_or_zombie_can_skip_process(self):
        for zombie in [False, True]:
            with self.subTest(zombie=zombie):
                self.f = telemetry.Fixture()
                path = f"{telemetry.PROC}/{telemetry.WRITER}/task/{telemetry.WRITER}/children"
                self.f.fs.text.pop(path)
                def exit_before_children(operation, current):
                    if operation == "read" and current == path:
                        stat_path = f"{telemetry.PROC}/{telemetry.WRITER}/stat"
                        if zombie:
                            self.f.fs.text[stat_path] = self.f.fs.text[stat_path].replace(") S ", ") Z ")
                        else:
                            self.f.fs.text.pop(stat_path)
                self.f.fs.hook = exit_before_children
                self.assertIn(self.unavailable()["category"], ["writer_unavailable", "process_exited"])

    def test_missing_children_rechecks_start_parent_and_name_before_skipping(self):
        for parent, start, name in [(telemetry.SESSION, 1000, "sftp-server"),
                                    (999, 999, "sftp-server"), (telemetry.SESSION, 999, "reused-process")]:
            with self.subTest(parent=parent, start=start, name=name):
                self.f = telemetry.Fixture()
                path = f"{telemetry.PROC}/{telemetry.WRITER}/task/{telemetry.WRITER}/children"
                self.f.fs.text.pop(path)
                def reuse_before_children(operation, current):
                    if operation == "read" and current == path:
                        self.f.fs.text[f"{telemetry.PROC}/{telemetry.WRITER}/stat"] = telemetry.process_stat(
                            telemetry.WRITER, name, parent, start=start)
                self.f.fs.hook = reuse_before_children
                self.unavailable("process_changed")

    def test_listener_query_filters_target_port_and_reaps_real_helper(self):
        popen, commands = subprocess.Popen, []
        def spawn_helper(command, **options):
            commands.append(command)
            return popen([sys.executable, "-B", "-c", "print('0 128 0.0.0.0:2222 0.0.0.0:* ino:900')"], **options)
        for listening in [False, True]:
            queries = receiver.QueryProcesses()
            try:
                with patch.object(receiver.subprocess, "Popen", side_effect=spawn_helper):
                    self.assertIn("ino:900", queries.query(2222, listening=listening))
                self.assertEqual(queries.children_active(), 0)
            finally:
                self.assertTrue(queries.cleanup())
        self.assertEqual(commands, [["ss", "-Hntipem", "state", "established", "( sport = :2222 )"],
                                    ["ss", "-Hnlte", "( sport = :2222 )"]])

    def test_listener_helper_limits_and_failures_keep_process_cleanup_bounded(self):
        popen = subprocess.Popen
        for category, code in [("ss_missing", None), ("ss_timeout", "import time;time.sleep(60)"),
            ("ss_failed", f"import sys;sys.stderr.write({SECRET!r});raise SystemExit(1)"),
            ("ss_output_limit", "import os,time;os.write(1,b'x'*32769);os.write(2,b'y'*32769);time.sleep(60)")]:
            with self.subTest(category=category):
                queries = receiver.QueryProcesses()
                def spawn_helper(_command, **options):
                    if code is None:
                        raise FileNotFoundError(errno.ENOENT, SECRET)
                    return popen([sys.executable, "-B", "-c", code], **options)
                started = time.monotonic()
                try:
                    with patch.object(receiver.subprocess, "Popen", side_effect=spawn_helper), \
                         self.assertRaises(receiver.ObservationFailure) as raised:
                        queries.query(2222, listening=True)
                    self.assertEqual(raised.exception.category, category)
                    self.assertNotIn(SECRET, str(raised.exception))
                    self.assertEqual(queries.children_active(), 0)
                    self.assertLess(time.monotonic() - started, 5)
                finally:
                    self.assertTrue(queries.cleanup())

if __name__ == "__main__":
    unittest.main(verbosity=2)
