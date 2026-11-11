# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import http.client
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fake_backplane  # noqa: E402
import qualify  # noqa: E402

# Built here, never written as a literal, so any trace of one is findable.
TOKEN = "bpc_" + "Q7" * 21 + "z"
OTHER_TOKEN = "bpc_" + "Wd" * 21 + "k"
INSTALLATION = "0a020000-0000-4000-8000-0000000000a1"


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class SplitRecordsTest(unittest.TestCase):
    def test_each_record_is_returned_byte_for_byte(self):
        first = b'{"capture_id":"a","text":"\\u003cb\\u003e"}'
        second = b'{"capture_id":"b","events":[{"n":1},{"n":2}]}'
        body = b'{"records":[' + first + b"," + second + b"]}"
        self.assertEqual(fake_backplane.split_records(body), [first, second])

    def test_an_empty_batch_has_no_records(self):
        self.assertEqual(fake_backplane.split_records(b'{"records":[]}'), [])


class FakeServerTest(unittest.TestCase):
    def setUp(self):
        self.control = Path(tempfile.mkdtemp())
        self.port, tripwire = free_port(), free_port()
        identities = [{"label": "A", "token": TOKEN, "installation_id": INSTALLATION, "owner_email": "owner@example.test"},
                      {"label": "R", "token": OTHER_TOKEN, "installation_id": INSTALLATION, "owner_email": "owner@example.test"}]
        self.servers = fake_backplane.serve(identities, "/srv/project", self.control, self.port, tripwire)

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()

    def faults(self, **faults):
        (self.control / "control.json").write_text(json.dumps(faults))

    def call(self, method, path, token=TOKEN, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, response.getheader("Content-Type"), response.read()
        finally:
            connection.close()

    def log(self):
        return [json.loads(line) for line in (self.control / "requests.jsonl").read_text().splitlines()]

    def test_me_answers_the_identity_the_token_was_issued_for(self):
        status, _, body = self.call("GET", "/api/companion/me")
        me = json.loads(body)
        self.assertEqual((status, me["installation"]["id"], me["user"]["email"]), (200, INSTALLATION, "owner@example.test"))

    def test_a_revoked_label_answers_invalid_device_token_and_others_still_verify(self):
        self.faults(revoked=["A"])
        status, _, body = self.call("GET", "/api/companion/policy")
        self.assertEqual((status, json.loads(body)["error_code"]), (401, "invalid_device_token"))
        self.assertEqual(self.call("GET", "/api/companion/policy", token=OTHER_TOKEN)[0], 200)

    def test_a_canned_proxy_401_carries_no_backend_error_code(self):
        self.faults(canned={"/api/companion/me": {"status": 401, "headers": {"Content-Type": "text/html"}, "body": "<html>401</html>"}})
        status, content_type, body = self.call("GET", "/api/companion/me")
        self.assertEqual((status, content_type, body), (401, "text/html", b"<html>401</html>"))

    def test_a_dropped_ingest_answer_is_stored_and_the_same_bytes_again_are_a_replay(self):
        self.faults(drop_ingest={"id": "once", "count": 1})
        body = b'{"records":[{"capture_id":"00000000000000000000000000000001","native_session_id":"s"}]}'
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionResetError)):
            self.call("POST", "/api/companion/ingest", body=body)
        status, _, answer = self.call("POST", "/api/companion/ingest", body=body)
        self.assertEqual((status, json.loads(answer)["acknowledged"]), (200, ["00000000000000000000000000000001"]))
        receipts = [entry["records"][0] for entry in self.log() if entry["event"] == "receipt"]
        self.assertEqual([receipt["replay"] for receipt in receipts], [False, True])
        self.assertEqual(receipts[0]["sha256"], receipts[1]["sha256"])
        self.assertIn("dropped", [entry.get("outcome") for entry in self.log()])

    def test_other_bytes_under_a_known_capture_id_are_a_conflict(self):
        self.call("POST", "/api/companion/ingest", body=b'{"records":[{"capture_id":"c1","n":1}]}')
        _, _, answer = self.call("POST", "/api/companion/ingest", body=b'{"records":[{"capture_id":"c1","n":2}]}')
        self.assertEqual(json.loads(answer)["rejected"], [{"capture_id": "c1", "reason": "conflict"}])

    def test_the_log_names_tokens_only_by_label(self):
        self.call("GET", "/api/companion/me")
        self.call("GET", "/api/companion/me", token="bpc_" + "Zz" * 21 + "q")
        self.assertEqual([entry["label"] for entry in self.log() if entry["event"] == "request"], ["A", "unknown"])
        log = (self.control / "requests.jsonl").read_bytes()
        self.assertEqual(qualify.find_traces(log, {"A": TOKEN, "R": OTHER_TOKEN}), [])


class QualifyHelpersTest(unittest.TestCase):
    def test_new_tokens_have_the_server_format_and_differ(self):
        first, second = qualify.new_token(), qualify.new_token()
        self.assertRegex(first, r"^bpc_[A-Za-z0-9_-]{43}$")
        self.assertNotEqual(first, second)

    def test_every_trace_form_is_found(self):
        for form, trace in qualify.token_traces(TOKEN).items():
            with self.subTest(form=form):
                # Forms overlap (the token holds its body), so each need only be among those found.
                self.assertIn(f"A:{form}", qualify.find_traces(b"..." + trace.encode() + b"...", {"A": TOKEN}))

    def test_the_binding_id_matches_the_companion_binary(self):
        # Observed from the built image's status for this identity.
        self.assertEqual(qualify.binding_id("http://127.0.0.1:8080", INSTALLATION, "operator@example.test"), "04a94525f430ffc029c9e378243b3323")

    def test_go_times_keep_their_nanoseconds(self):
        self.assertAlmostEqual(qualify.go_time("2026-10-24T04:52:15.874194298Z") - qualify.go_time("2026-10-24T04:52:15Z"), 0.874194298, places=6)


if __name__ == "__main__":
    unittest.main()
