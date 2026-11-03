"""Signal handlers must return even when the main thread owns Event's condition."""

import contextlib
import io
import json
import signal
import subprocess
import sys
import textwrap
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from receiver_telemetry_test import CONFIG, ROOT, receiver


CHILD_TIMEOUT_SECONDS = 2


class ReceiverSignalTests(unittest.TestCase):
    def signal_child(self, signals, *, seconds=30):
        script = ROOT / "scripts/deploy/receiver-telemetry.py"
        launcher = textwrap.dedent(f"""
            import importlib.util, json, signal, sys, threading, time
            from types import SimpleNamespace
            spec = importlib.util.spec_from_file_location('receiver_child', {str(script)!r})
            m = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = m
            spec.loader.exec_module(m)
            real_event, real_thread = threading.Event, threading.Thread
            events, threads, returned = [], [], []
            requested = {list(signals)!r}
            class SignalEvent(real_event):
                def __init__(self):
                    super().__init__()
                    self.injected = False
                    events.append(self)
                def wait(self, timeout=None):
                    if (self is events[0] and threading.current_thread() is threading.main_thread()
                            and requested and not self.injected):
                        self.injected = True
                        with self._cond:
                            for signum in requested:
                                signal.raise_signal(signum)
                                returned.append(signum)
                    return super().wait(timeout)
            def create_thread(*args, **kwargs):
                threads.append(kwargs['target'].__name__)
                return real_thread(*args, **kwargs)
            m.threading.Event = SignalEvent
            m.threading.Thread = create_thread
            config = dict({CONFIG!r}, deadline_seconds={seconds!r},
                          sample_interval_seconds=15, discovery_interval_seconds=1)
            m.parse_config = lambda argv: config
            collector = SimpleNamespace(started=time.monotonic(),
                queries=SimpleNamespace(cleanup=lambda: True, children_active=lambda: 0),
                sample=lambda: {{'status': 'available', 'category': 'ok'}})
            m.ReceiverTelemetry = lambda config: collector
            code = m.main([])
            print(json.dumps({{'threads': threads, 'returned': returned}}), file=sys.stderr)
            raise SystemExit(code)
        """)
        child = subprocess.Popen([sys.executable, "-B", "-c", launcher], cwd=ROOT,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        started = time.monotonic()
        try:
            stdout, stderr = child.communicate(timeout=CHILD_TIMEOUT_SECONDS)
            self.assertEqual(child.returncode, 0, stderr)
            rows = [json.loads(line) for line in stdout.splitlines()]
            metadata = json.loads(stderr)
            self.assertEqual(metadata["threads"], ["watchdog"])
            self.assertEqual(metadata["returned"], list(signals))
            completions = [row for row in rows if row.get("event") == "receiver_complete"]
            self.assertEqual(len(completions), 1)
            self.assertEqual(completions[0]["cleanup"], "confirmed")
            self.assertEqual(completions[0]["children_active"], 0)
            return completions[0], time.monotonic() - started
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=CHILD_TIMEOUT_SECONDS)

    def test_sigterm_returns_while_main_thread_holds_stop_condition(self):
        completion, elapsed = self.signal_child([int(signal.SIGTERM)])
        self.assertEqual(completion["reason"], "signal")
        self.assertLess(elapsed, CHILD_TIMEOUT_SECONDS)

    def test_repeated_sigterm_and_sigint_do_not_reenter_locks_or_start_threads(self):
        signals = [int(signal.SIGTERM), int(signal.SIGINT)] * 32
        completion, elapsed = self.signal_child(signals)
        self.assertEqual(completion["reason"], "signal")
        self.assertLess(elapsed, CHILD_TIMEOUT_SECONDS)

    def test_watchdog_polling_preserves_absolute_deadline(self):
        completion, elapsed = self.signal_child([], seconds=0.15)
        self.assertEqual(completion["reason"], "deadline")
        self.assertLess(elapsed, 1)

    def test_repeated_signals_cancel_and_reap_sigterm_resistant_helper(self):
        queries, helpers, output = receiver.QueryProcesses(), [], io.StringIO()
        popen = subprocess.Popen
        helper_code = textwrap.dedent("""
            import os, signal, time
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            for signum in [signal.SIGTERM, signal.SIGINT] * 8:
                os.kill(os.getppid(), signum)
                time.sleep(0.002)
            time.sleep(60)
        """)
        def spawn_helper(_command, **options):
            child = popen([sys.executable, "-B", "-c", helper_code], **options)
            helpers.append(child)
            return child
        def sample():
            try:
                queries.query(22)
            except receiver.ObservationFailure as error:
                return {"status": "unavailable", "category": error.category}
            self.fail("the sleeping helper unexpectedly completed")
        collector = SimpleNamespace(started=time.monotonic(), queries=queries, sample=sample)
        config = dict(CONFIG, deadline_seconds=3, sample_interval_seconds=15,
                      discovery_interval_seconds=1)
        handlers = {signum: signal.getsignal(signum) for signum in (signal.SIGTERM, signal.SIGINT)}
        started = time.monotonic()
        try:
            with patch.object(receiver, "parse_config", return_value=config), \
                 patch.object(receiver, "ReceiverTelemetry", return_value=collector), \
                 patch.object(receiver.subprocess, "Popen", side_effect=spawn_helper), \
                 contextlib.redirect_stdout(output):
                self.assertEqual(receiver.main([]), 0)
            self.assertLess(time.monotonic() - started, 4)
            self.assertEqual(len(helpers), 1)
            self.assertEqual(helpers[0].returncode, -signal.SIGKILL)
            self.assertFalse(queries.active(helpers[0].pid))
            self.assertEqual(queries.children_active(), 0)
            rows = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(rows[0]["category"], "cancelled")
            completions = [row for row in rows if row.get("event") == "receiver_complete"]
            self.assertEqual(len(completions), 1)
            self.assertEqual(completions[0]["reason"], "signal")
            self.assertEqual(completions[0]["cleanup"], "confirmed")
            self.assertEqual(completions[0]["children_active"], 0)
        finally:
            try:
                self.assertTrue(queries.cleanup())
            finally:
                try:
                    for child in helpers:
                        if child.poll() is None:
                            child.kill()
                        child.communicate(timeout=CHILD_TIMEOUT_SECONDS)
                finally:
                    for signum, handler in handlers.items():
                        signal.signal(signum, handler)


if __name__ == "__main__":
    unittest.main(verbosity=2)
