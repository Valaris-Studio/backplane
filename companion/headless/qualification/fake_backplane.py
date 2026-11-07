# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""A fake of the Backplane companion API for qualifying the headless
container: the capture routes, scripted faults and a request log.

Device tokens arrive on stdin as one JSON document, read before serving, so
no token is ever on disk, in argv or in the environment:

    {"identities": [{"label": "A", "token": "bpc_...", "installation_id": "...",
                     "owner_email": "..."}],
     "mapping_root": "/srv/hw-project"}

Faults are read from <control>/control.json on every request:

    {"revoked": ["A"],                       labels answered 401 invalid_device_token
     "canned": {"/api/companion/me": {"status": 302, "headers": {...}, "body": ""}},
     "stall": ["/api/companion/ingest"],     held open until no longer listed
     "drop_ingest": {"id": "s6", "count": 1}} that many ingest answers withheld

<control>/requests.jsonl gets one line per request and one per outcome; a
token appears there only as its label. The tripwire port logs every
connection to <control>/tripwire.jsonl: a redirect target or a session bus
address pointed at it proves nothing followed or dialed it.
"""

import argparse
import hashlib
import http.server
import json
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path

ALLOWED_ROUTES = {("GET", "/api/companion/me"), ("GET", "/api/companion/policy"), ("POST", "/api/companion/status"), ("POST", "/api/companion/ingest")}
CONTENTS_PREFIX = "/api/companion/contents/"
STALL_LIMIT_SECONDS = 120


def split_records(body):
    """The raw bytes of each element of an ingest body's "records" array,
    exactly as sent, so a retransmission can be compared byte for byte."""
    text = body.decode("utf-8")
    decoder = json.JSONDecoder()
    start = text.index("[", text.index('"records"')) + 1
    records = []
    position = start
    while True:
        while text[position] in " \t\r\n,":
            position += 1
        if text[position] == "]":
            return records
        _, end = decoder.raw_decode(text, position)
        records.append(text[position:end].encode("utf-8"))
        position = end


def record_summary(raw):
    record = json.loads(raw)
    return {"capture_id": record.get("capture_id", ""), "session": record.get("native_session_id", ""), "sha256": hashlib.sha256(raw).hexdigest()}


class Fake:
    def __init__(self, identities, mapping_root, control_dir, port):
        self.by_token = {identity["token"]: identity for identity in identities}
        self.mapping_root = mapping_root
        self.control_dir = Path(control_dir)
        self.port = port
        self.receipts = {}
        self.drops_done = {}
        self.sequence = 0
        self.lock = threading.Lock()

    def control(self):
        try:
            return json.loads((self.control_dir / "control.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def log(self, entry):
        entry = dict(entry, at=time.time(), port=self.port)
        with self.lock, (self.control_dir / "requests.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, sort_keys=True) + "\n")

    def next_sequence(self):
        with self.lock:
            self.sequence += 1
            return self.sequence

    def label(self, authorization):
        if not authorization.startswith("Bearer "):
            return "none"
        identity = self.by_token.get(authorization[len("Bearer "):])
        return identity["label"] if identity else "unknown"

    def receive(self, records):
        """Stores each record's digest the way the backend's ingest receipt
        does: the same bytes again are a replay, other bytes a conflict."""
        received = []
        with self.lock:
            for raw in records:
                summary = record_summary(raw)
                capture_id, digest = summary["capture_id"], summary["sha256"]
                known = self.receipts.get(capture_id)
                received.append(dict(summary, replay=known == digest, conflict=known not in (None, digest)))
                if known is None:
                    self.receipts[capture_id] = digest
        return received

    def should_drop(self, control):
        plan = control.get("drop_ingest")
        if not plan:
            return False
        with self.lock:
            done = self.drops_done.get(plan["id"], 0)
            if done >= plan["count"]:
                return False
            self.drops_done[plan["id"]] = done + 1
            return True

    def answer(self, method, path, label, body):
        """(status, headers, body, receipts) for an authenticated device
        route; receipts are the ingest records as stored."""
        identity = next((identity for identity in self.by_token.values() if identity["label"] == label), None)
        if identity is None:
            return 401, {}, {"detail": "Invalid or revoked device token", "error_code": "invalid_device_token"}, None
        if method == "GET" and path == "/api/companion/me":
            return 200, {}, {"user": {"email": identity["owner_email"], "display_name": None},
                             "installation": {"id": identity["installation_id"], "name": "hw02-headless"}, "web_origin": None}, None
        if method == "GET" and path == "/api/companion/policy":
            return 200, {}, {
                "installation": {"id": identity["installation_id"], "paused": False, "auto_match_repos": False,
                                 "enabled_agents": ["claude_code"], "exclude_globs": [], "retention_days": None},
                "mappings": [{"id": "hw02-mapping", "workspace_id": "hw02-workspace", "board_id": "hw02-board",
                              "root_path": self.mapping_root, "enabled": True, "content_level": "standard"}],
                "repo_catalog": [],
            }, None
        if method == "POST" and path == "/api/companion/status":
            return 200, {}, {"recorded": True}, None
        if method == "POST" and path == "/api/companion/ingest":
            received = self.receive(split_records(body))
            return 200, {}, {"acknowledged": [record["capture_id"] for record in received if not record["conflict"]],
                             "rejected": [{"capture_id": record["capture_id"], "reason": "conflict"} for record in received if record["conflict"]],
                             "dropped": [], "history_deleted": [], "contents": []}, received
        return 404, {}, {"detail": "Not Found"}, None


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    fake = None

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PATCH(self):
        self.handle_any("PATCH")

    def do_DELETE(self):
        self.handle_any("DELETE")

    def handle_any(self, method):
        fake = self.fake
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        sequence = fake.next_sequence()
        label = fake.label(self.headers.get("Authorization", ""))
        allowed = (method, self.path) in ALLOWED_ROUTES or self.path.startswith(CONTENTS_PREFIX)
        entry = {"seq": sequence, "event": "request", "method": method, "path": self.path, "label": label, "allowed": allowed}
        if method == "POST" and self.path == "/api/companion/ingest":
            try:
                entry["records"] = [record_summary(raw) for raw in split_records(body)]
            except (ValueError, IndexError):
                entry["records"] = "unparseable"
        if method == "POST" and self.path == "/api/companion/status":
            entry["heartbeat"] = json.loads(body or b"{}")
        fake.log(entry)

        control = fake.control()
        if self.path in control.get("stall", []):
            stalled_since = time.monotonic()
            while self.path in fake.control().get("stall", []) and time.monotonic() - stalled_since < STALL_LIMIT_SECONDS:
                time.sleep(0.05)
            control = fake.control()
        canned = control.get("canned", {}).get(self.path)
        if canned:
            self.send(sequence, canned["status"], canned.get("headers", {}), canned.get("body", "").encode("utf-8"), "canned")
            return
        if label in ("none", "unknown") or label in control.get("revoked", []):
            reply = {"detail": "Invalid or revoked device token", "error_code": "invalid_device_token"} if label != "none" else {"detail": "Not authenticated"}
            self.send(sequence, 401, {}, json.dumps(reply).encode("utf-8"), "unauthorized")
            return
        status, headers, reply, receipts = fake.answer(method, self.path, label, body)
        if receipts is not None:
            fake.log({"seq": sequence, "event": "receipt", "records": receipts})
            if fake.should_drop(control):
                # Stored, but the answer is lost: the client cannot know.
                fake.log({"seq": sequence, "event": "outcome", "outcome": "dropped"})
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                return
        self.send(sequence, status, headers, json.dumps(reply).encode("utf-8"), "answered")

    def send(self, sequence, status, headers, payload, outcome):
        try:
            self.send_response(status)
            content_type = headers.get("Content-Type", "application/json")
            self.send_header("Content-Type", content_type)
            for name, value in headers.items():
                if name != "Content-Type":
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
        except OSError:
            outcome = "client_gone"
        self.fake.log({"seq": sequence, "event": "outcome", "outcome": outcome, "status": status})


class TripwireHandler(socketserver.BaseRequestHandler):
    control_dir = None

    def handle(self):
        self.request.settimeout(2)
        try:
            first = self.request.recv(256)
        except OSError:
            first = b""
        with (self.control_dir / "tripwire.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"at": time.time(), "bytes": len(first)}) + "\n")


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(identities, mapping_root, control_dir, port, tripwire_port, host="127.0.0.1"):
    """Starts the fake (and its tripwire) in background threads and returns
    the servers."""
    fake = Fake(identities, mapping_root, control_dir, port)
    handler = type("BoundHandler", (Handler,), {"fake": fake})
    server = http.server.ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    servers = [server]
    if tripwire_port:
        tripwire = ThreadingTCPServer((host, tripwire_port), type("BoundTripwire", (TripwireHandler,), {"control_dir": Path(control_dir)}))
        servers.append(tripwire)
    for running in servers:
        threading.Thread(target=running.serve_forever, daemon=True).start()
    return servers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--tripwire-port", type=int, default=0)
    parser.add_argument("--control", required=True)
    arguments = parser.parse_args()
    document = json.load(sys.stdin)
    serve(document["identities"], document["mapping_root"], arguments.control, arguments.port, arguments.tripwire_port)
    print(json.dumps({"serving": arguments.port, "tripwire": arguments.tripwire_port, "labels": sorted(identity["label"] for identity in document["identities"])}), flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
