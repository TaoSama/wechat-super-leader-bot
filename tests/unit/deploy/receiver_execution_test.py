"""Receiver CLI, sampling-loop, and real signal lifecycle contracts."""

import contextlib
import io
import json
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from receiver_telemetry_test import CONFIG, CONFIG_ARGS, ROOT, SECRET, receiver


class ReceiverExecutionTests(unittest.TestCase):
    def run_main(self, sample, *, seconds=1200, cleanup=True, children=0):
        clock, waits, output = [0], [], io.StringIO()
        class Event:
            value = False
            def set(self): self.value = True
            def is_set(self): return self.value
            def wait(self, interval):
                waits.append(interval)
                clock[0] += interval
                return self.value
        queries = SimpleNamespace(cleanup=Mock(return_value=cleanup),
                                  children_active=Mock(return_value=children))
        collector = SimpleNamespace(started=0, queries=queries, sample=sample)
        config = dict(CONFIG, deadline_seconds=seconds, sample_interval_seconds=15,
                      discovery_interval_seconds=1)
        with patch.object(receiver, "parse_config", return_value=config), \
             patch.object(receiver, "ReceiverTelemetry", return_value=collector), \
             patch.object(receiver.threading, "Event", Event), \
             patch.object(receiver.threading, "Thread"), \
             patch.object(receiver.signal, "signal"), \
             patch.object(receiver.time, "monotonic", side_effect=lambda: clock[0]), \
             contextlib.redirect_stdout(output):
            code = receiver.main([])
        queries.cleanup.assert_called_once()
        return code, [json.loads(line) for line in output.getvalue().splitlines()], waits, output.getvalue()

    def test_discovery_polling_and_periodic_logs_are_bounded(self):
        sample = Mock(return_value={"status": "unavailable", "category": "writer_unavailable"})
        code, rows, waits, _ = self.run_main(sample, seconds=75)
        self.assertEqual(code, 0)
        self.assertEqual(sample.call_count, 61)
        self.assertEqual(waits[:60], [1] * 60)
        self.assertEqual(waits[60:], [15])
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[-1]["reason"], "deadline")
        self.assertEqual(rows[-1]["cleanup"], "confirmed")

    def test_count_and_byte_limits_leave_room_for_cleanup_record(self):
        counter = [0]
        def changing_sample():
            counter[0] += 1
            return {"status": "unavailable", "category": str(counter[0] % 2)}
        _, rows, _, text = self.run_main(changing_sample)
        self.assertLessEqual(len(rows), 128)
        self.assertEqual(rows[-1]["reason"], "output_limit")
        oversized = lambda: {"status": "available", "category": "ok", "padding": "x" * (2 * 1024 * 1024)}
        _, rows, _, text = self.run_main(oversized)
        self.assertEqual(len(rows), 1)
        self.assertLessEqual(len(text.encode()), 2 * 1024 * 1024)
        self.assertEqual(rows[-1]["cleanup"], "confirmed")

    def test_unconfirmed_cleanup_is_nonzero_and_never_claims_confirmation(self):
        code, rows, _, _ = self.run_main(Mock(), seconds=0, cleanup=False, children=1)
        self.assertEqual(code, 1)
        self.assertEqual(rows[-1]["cleanup"], "unconfirmed")
        self.assertEqual(rows[-1]["children_active"], 1)

    def test_unexpected_query_failure_is_reported_without_exception_text(self):
        _, rows, _, text = self.run_main(Mock(side_effect=RuntimeError(SECRET)))
        self.assertEqual(rows[-1]["reason"], "unexpected_error")
        self.assertNotIn(SECRET, text)

    def test_config_uses_job_start_and_rejects_unbounded_limits(self):
        argv = CONFIG_ARGS
        started = receiver.datetime.datetime.fromisoformat(CONFIG["job_started_at"].replace("Z", "+00:00")).timestamp()
        with patch.object(receiver.time, "time", return_value=started + 1190):
            self.assertEqual(receiver.parse_config(argv)["deadline_seconds"], 10)
        for args in [["--duration-seconds", "1201"], ["--sample-interval-seconds", "16"],
                     ["--discovery-interval-seconds", "2"], ["--duration-seconds", "nan"]]:
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                receiver.parse_config(argv + args)

    def test_argparse_errors_do_not_echo_unknown_arguments_or_float_values(self):
        for args in [["--unknown", SECRET], ["--duration-seconds", SECRET]]:
            with self.subTest(args=args):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
                    receiver.parse_config(CONFIG_ARGS + args)
                self.assertNotIn(SECRET, stderr.getvalue())

    def test_sigterm_exits_within_bound_when_stdout_pipe_is_full(self):
        script = ROOT / "scripts/deploy/receiver-telemetry.py"
        launcher = ("import importlib.util,sys; "
                    f"s=importlib.util.spec_from_file_location('receiver_child',{str(script)!r}); "
                    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m; "
                    "s.loader.exec_module(m);m.sys.platform='linux';raise SystemExit(m.main())")
        with tempfile.TemporaryDirectory(prefix="receiver-backpressure-") as directory:
            args = CONFIG_ARGS + ["--release-path", directory,
                "--job-started-at", receiver.datetime.datetime.now(receiver.datetime.timezone.utc).isoformat(),
                "--duration-seconds", "30", "--sample-interval-seconds", ".001",
                "--discovery-interval-seconds", ".001"]
            child = subprocess.Popen([sys.executable, "-B", "-c", launcher, *args], cwd=ROOT,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                time.sleep(0.8)
                self.assertIsNone(child.poll(), "collector exited before stdout backpressure")
                signaled = time.monotonic()
                child.send_signal(signal.SIGTERM)
                code = child.wait(timeout=7)
                elapsed = time.monotonic() - signaled
                stdout, stderr = child.communicate(timeout=1)
                self.assertNotEqual(code, 0, stderr)
                self.assertLess(elapsed, 7)
                lines = stdout.splitlines()
                if lines and not lines[-1].endswith("}"):
                    lines.pop()  # A forced exit may interrupt the final JSON record.
                rows = [json.loads(line) for line in lines]
                self.assertTrue(any(row.get("category") == "stage_missing" for row in rows))
                completions = [row for row in rows if row.get("event") == "receiver_complete"]
                self.assertLessEqual(len(completions), 1)
                for row in completions:
                    if row["cleanup"] == "confirmed":
                        self.assertEqual(row["children_active"], 0)
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=3)

if __name__ == "__main__":
    unittest.main(verbosity=2)
