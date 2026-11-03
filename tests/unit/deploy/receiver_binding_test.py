"""Connection attribution follows the validated owner-to-writer process chain."""

import unittest

import receiver_telemetry_test as telemetry


class ReceiverOwnerBindingTests(telemetry.ReceiverAssertions, unittest.TestCase):
    def unbound_sample(self, category):
        output = self.unavailable(category)
        self.assertTrue(all(value is None for value in output["identifiers"].values()))
        for process in output["processes"].values():
            self.assertEqual(process["status"], "unavailable")
            self.assertEqual(process["io_status"], "unavailable")
            for field in ("cpu_user_ticks", "cpu_system_ticks", "wchar", "write_bytes",
                          "cancelled_write_bytes"):
                self.assertIsNone(process[field], field)
        self.assertIsNone(output["received_bytes"])
        self.assertIsNone(output["remaining_bytes"])
        return output

    def shared_owners(self, monitor=150, connection=200, intermediate=None):
        self.f = telemetry.Fixture()
        writer = telemetry.WRITER
        self.f.process(monitor, "sshd", 100, children=[connection], start=1100)
        self.f.process(connection, "sshd-session", monitor,
                       children=[intermediate or writer], start=1200)
        if intermediate:
            self.f.process(intermediate, "python3", connection, children=[writer], start=1300)
        self.f.fs.text[f"{telemetry.PROC}/100/task/100/children"] = str(monitor)
        self.f.fs.text[f"{telemetry.PROC}/{writer}/stat"] = telemetry.process_stat(
            writer, "sftp-server", intermediate or connection, start=1400)
        self.f.fs.text[f"{telemetry.PROC}/{monitor}/stat"] = telemetry.process_stat(
            monitor, "sshd", 100, start=1100, user=1, system=2)
        self.f.fs.text[f"{telemetry.PROC}/{connection}/stat"] = telemetry.process_stat(
            connection, "sshd-session", monitor, start=1200, user=90, system=30)
        for pid in [monitor, connection]:
            self.f.fs.dirs[f"{telemetry.PROC}/{pid}/fd"] = []
        self.f.socket(monitor, 3, telemetry.SOCKET)
        self.f.socket(connection, 7, telemetry.SOCKET)
        self.f.ss = telemetry.socket_line(((monitor, 3), (connection, 7)))

    def test_closest_owner_and_its_cpu_are_selected_independently_of_pid_order(self):
        for monitor, connection in [(150, 200), (200, 150)]:
            with self.subTest(monitor=monitor, connection=connection):
                self.shared_owners(monitor, connection)
                output = self.sample()
                self.assertEqual(output["status"], "available")
                self.assertEqual(output["identifiers"]["owner_pid"], connection)
                self.assertEqual(output["identifiers"]["owner_start_ticks"], 1200)
                self.assertEqual(output["identifiers"]["socket_fd"], 7)
                self.assertEqual(output["processes"]["connection"]["cpu_user_ticks"], 90)
                self.assertEqual(output["processes"]["connection"]["cpu_system_ticks"], 30)

    def test_closest_owner_can_be_above_a_non_socket_intermediate_process(self):
        self.shared_owners(intermediate=250)
        output = self.sample()
        self.assertEqual(output["status"], "available")
        self.assertEqual(output["identifiers"]["owner_pid"], 200)
        self.assertEqual(output["processes"]["connection"]["cpu_user_ticks"], 90)

    def test_writer_owning_the_shared_socket_remains_the_closest_owner(self):
        self.shared_owners()
        self.f.socket(telemetry.WRITER, 8, telemetry.SOCKET)
        self.f.ss = telemetry.socket_line(((150, 3), (200, 7), (telemetry.WRITER, 8)))
        output = self.sample()
        self.assertEqual(output["status"], "available")
        self.assertEqual(output["identifiers"]["owner_pid"], telemetry.WRITER)
        self.assertEqual(output["identifiers"]["socket_fd"], 8)

    def test_selected_owner_and_each_intermediate_are_freshly_rechecked(self):
        for pid, parent, name in [(200, 150, "sshd-session"), (250, 200, "python3")]:
            with self.subTest(pid=pid):
                self.shared_owners(intermediate=250)
                def reuse_during_metrics(operation, path):
                    if operation == "read" and path == f"{telemetry.PROC}/{telemetry.WRITER}/io":
                        self.f.fs.hook = None
                        self.f.fs.text[f"{telemetry.PROC}/{pid}/stat"] = telemetry.process_stat(
                            pid, name, parent, start=9999)
                self.f.fs.hook = reuse_during_metrics
                self.unbound_sample("process_changed")

    def test_shared_listener_is_rejected_even_when_its_owner_is_closest(self):
        self.shared_owners()
        self.f.socket(200, 9, 900)
        self.unavailable("owner_shared")

    def test_mixed_owned_and_ownerless_candidates_reject_partial_attribution(self):
        owned = telemetry.socket_line()
        ownerless = telemetry.socket_line((), socket_inode=telemetry.SOCKET + 1)
        for rows in [(owned, ownerless), (ownerless, owned)]:
            with self.subTest(ownerless_first=rows[0] == ownerless):
                self.f = telemetry.Fixture()
                self.f.ss = "".join(rows)
                self.unbound_sample("socket_owner_missing")
                self.assertFalse(any(operation in ("list", "link")
                                     for operation, _, _ in self.f.fs.calls))

    def test_all_ownerless_candidates_are_rejected(self):
        for count in (1, telemetry.receiver.CONNECTION_LIMIT):
            with self.subTest(count=count):
                self.f = telemetry.Fixture()
                self.f.ss = "".join(telemetry.socket_line((), socket_inode=telemetry.SOCKET + index)
                                    for index in range(count))
                self.unbound_sample("socket_owner_missing")

    def test_every_raw_candidate_counts_towards_socket_limit(self):
        count = telemetry.receiver.CONNECTION_LIMIT + 1
        for owned_count in (0, 1, count - 1, count):
            with self.subTest(owned_count=owned_count):
                self.f = telemetry.Fixture()
                self.f.ss = "".join(telemetry.socket_line(
                    ((telemetry.SESSION, 3),) if index < owned_count else (),
                    socket_inode=telemetry.SOCKET + index) for index in range(count))
                self.unbound_sample("proc_limit")


if __name__ == "__main__":
    unittest.main(verbosity=2)
