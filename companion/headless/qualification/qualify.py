#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Qualifies the headless Companion container against two fake servers on
loopback, with no egress, and writes the evidence:

    python3 qualify.py --image backplane-companion-headless:dev \\
        --platform linux/amd64 --evidence DIR [--prefix hw-run-hw02] [--keep]

The Companion runs from ../compose.example.yaml with compose.qualification.yaml
layered over it. Only containers and volumes named <prefix>-* are created,
and only those are removed at the end (listed first). Device tokens are made
here, reach the fakes and the token volume on stdin only, and every log,
status and evidence file is then searched for any trace of them.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

PYTHON_IMAGE = "python@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39"  # python:3.13-slim
DEBIAN_IMAGE = "debian@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8"  # debian:12-slim
COMPANION_UID = 10001
CODING_UID = 10000  # the worker image's coding user
EXECUTABLE = "/opt/backplane-companion/backplane-companion"
TOKEN_PATH = "/run/backplane-companion/token/device-token"
DATA_ROOT = "/var/lib/backplane-companion"
MAPPED_ROOT = "/srv/hw-project"
PORT_A, PORT_B, TRIPWIRE_PORT = 8080, 8081, 8099
ORIGIN_A, ORIGIN_B = f"http://127.0.0.1:{PORT_A}", f"http://127.0.0.1:{PORT_B}"
INSTALLATION_A = "0a020000-0000-4000-8000-0000000000a1"
INSTALLATION_B = "0a020000-0000-4000-8000-0000000000b2"
OWNER = "operator@example.test"
HERE = Path(__file__).resolve().parent
HEADLESS = HERE.parent
INGEST, ME = "/api/companion/ingest", "/api/companion/me"


class QualificationError(RuntimeError):
    pass


def new_token():
    """A device token in the server's exact format, made fresh each run."""
    return "bpc_" + secrets.token_urlsafe(32)


def token_traces(token):
    """Every form a leaked token could take: the forms the Go harness checks."""
    plain = hashlib.sha256(token.encode()).hexdigest()
    return {
        "token": token, "token body": token.removeprefix("bpc_"), "sha256": plain, "sha256 prefix": plain[:16],
        "sha256 of file": hashlib.sha256((token + "\n").encode()).hexdigest(),
        "base64": base64.b64encode(token.encode()).decode(),
        "base64 url": base64.urlsafe_b64encode(token.encode()).decode().rstrip("="),
    }


def find_traces(data, tokens):
    """The token traces in data, named by label and form."""
    return [f"{label}:{form}" for label, token in sorted(tokens.items()) for form, trace in token_traces(token).items() if trace.encode() in data]


def binding_id(origin, installation_id, owner_email):
    return hashlib.sha256(f"backplane-companion-binding/v1\n{origin}\n{installation_id}\n{owner_email}".encode()).hexdigest()[:32]


def go_time(value):
    """A Go RFC 3339 time (nanoseconds) as epoch seconds."""
    head, _, rest = value.rstrip("Z").partition(".")
    fraction = float("0." + rest) if rest else 0.0
    return datetime.datetime.fromisoformat(head).replace(tzinfo=datetime.timezone.utc).timestamp() + fraction


def stamp(seconds=None):
    return datetime.datetime.fromtimestamp(time.time() if seconds is None else seconds, datetime.timezone.utc).isoformat(timespec="milliseconds")


READER = r"""
import hashlib, json, os, sys
root = "/data"
files, documents, directories = {}, {}, {}
for directory, subdirectories, names in os.walk(root):
    directories[os.path.relpath(directory, root)] = len(subdirectories) + len(names)
    for name in names:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root)
        if os.path.islink(path) or not os.path.isfile(path):
            files[relative] = "not-regular"
            continue
        with open(path, "rb") as stream:
            data = stream.read()
        files[relative] = hashlib.sha256(data).hexdigest()
        if name in ("binding.json", "headless.json", "admission.json", "installation.json", "preferences.json", "binding-switch.json"):
            documents[relative] = json.loads(data)
json.dump({"files": files, "documents": documents, "directories": directories}, sys.stdout, sort_keys=True)
"""

ISOLATION = r"""
import json, os, socket
results = {}
def attempt(name, action):
    try:
        results[name] = {"allowed": True, "detail": action()}
    except OSError as error:
        results[name] = {"allowed": False, "errno": error.errno, "error": os.strerror(error.errno)}
attempt("read token file", lambda: len(open("/run/backplane-companion/token/device-token", "rb").read()))
attempt("list token directory", lambda: len(os.listdir("/run/backplane-companion/token")))
attempt("list data root", lambda: len(os.listdir("/var/lib/backplane-companion")))
attempt("read binding.json", lambda: len(open("/var/lib/backplane-companion/binding.json", "rb").read()))
attempt("stat control socket", lambda: oct(os.stat("/var/lib/backplane-companion/control.sock").st_mode))
def connect():
    connection = socket.socket(socket.AF_UNIX)
    connection.settimeout(2)
    connection.connect("/var/lib/backplane-companion/control.sock")
    return "connected"
attempt("connect control socket", connect)
attempt("create file in data root", lambda: open("/var/lib/backplane-companion/planted", "xb").close())
attempt("read config", lambda: len(open("/etc/backplane-companion/config.json", "rb").read()))
results["identity"] = {"uid": os.getuid(), "gid": os.getgid(), "groups": os.getgroups()}
print(json.dumps(results, sort_keys=True))
"""

PROCESS_PROBE = r"""
import json
status = dict(line.split(":", 1) for line in open("/proc/1/status").read().splitlines() if ":" in line)
fields = {name: status[name].strip() for name in ("Name", "Uid", "Gid", "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp")}
mounts = [line.split() for line in open("/proc/1/mountinfo").read().splitlines()]
root = next(line for line in mounts if line[4] == "/")
fields["root mount options"] = root[5]
fields["mount points"] = sorted(line[4] for line in mounts)
fields["docker socket mounted"] = any("docker.sock" in line[4] or "docker.sock" in line[3] for line in mounts)
print(json.dumps(fields, sort_keys=True))
"""

NETNS_PROBE = r"""
import json, os, socket
# A namespace always lists the kernel's fallback tunnel devices; only an
# interface that is up can carry traffic.
interfaces = sorted(name for name in os.listdir("/sys/class/net") if os.path.isdir(f"/sys/class/net/{name}"))
result = {"interfaces": interfaces, "interfaces up": [name for name in interfaces if int(open(f"/sys/class/net/{name}/flags").read(), 16) & 1],
          "ipv4 routes": open("/proc/net/route").read().splitlines()[1:],
          "ipv6 route devices": sorted({line.split()[-1] for line in open("/proc/net/ipv6_route").read().splitlines()})}
def dial(host, port):
    connection = socket.socket()
    connection.settimeout(3)
    try:
        connection.connect((host, port))
        return "connected"
    except OSError as error:
        return f"{error.errno} {os.strerror(error.errno) if error.errno else error}"
    finally:
        connection.close()
result["dial 1.1.1.1:443"] = dial("1.1.1.1", 443)
result["dial 192.168.65.254:443 (Docker Desktop host gateway)"] = dial("192.168.65.254", 443)
try:
    result["resolve example.com"] = socket.getaddrinfo("example.com", 443)[0][4][0]
except OSError as error:
    result["resolve example.com"] = f"{type(error).__name__}: {error}"
result["dial 127.0.0.1:8080 (fake A)"] = dial("127.0.0.1", 8080)
print(json.dumps(result, sort_keys=True))
"""

CONTROL_PROBE = r"""
import http.client, json, os, socket
# Through the Companion's own mount namespace when /proc/1/root is reachable
# (same UID, shared PID namespace), else through the shared data volume.
candidates = ["/proc/1/root/var/lib/backplane-companion/control.sock", "/data/control.sock"]
results = {"uid": os.getuid(), "gid": os.getgid()}
chosen = None
for path in candidates:
    try:
        probe = socket.socket(socket.AF_UNIX)
        probe.connect(path)
        probe.close()
        chosen = path
        break
    except OSError as error:
        results[f"connect {path}"] = f"{error.errno} {os.strerror(error.errno)}"
results["socket"] = chosen

class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(10)
        self.sock.connect(chosen)

requests = [("GET", "/v1/status", None), ("POST", "/v1/pause", {}), ("POST", "/v1/resume", {}),
            ("POST", "/v1/projects/ignore", {"path": "/srv/hw-project"}), ("PATCH", "/v1/settings", {"auto_match_repos": True}),
            ("POST", "/v1/queue/flush", {}), ("POST", "/v1/agents/claude_code/install", {})]
for method, route, body in requests:
    connection = UnixConnection("companion", timeout=10)
    headers = {"Content-Type": "application/json"} if body is not None else {}
    connection.request(method, route, body=json.dumps(body) if body is not None else None, headers=headers)
    response = connection.getresponse()
    data = response.read()
    try:
        code = (json.loads(data).get("error") or {}).get("code")
    except ValueError:
        code = None
    results[f"{method} {route}"] = {"status": response.status, "error code": code}
    connection.close()
print(json.dumps(results, sort_keys=True))
"""


def verdicts(observed, binding_a, binding_b):
    """PASS when every check of a scenario holds, else FAIL naming the
    checks that did not; a scenario that did not run is UNTESTED."""
    def check(number, checks):
        details = observed.get(number)
        if details is None:
            return {"verdict": "UNTESTED", "failed": ["not run"]}
        if "error" in details:
            return {"verdict": "FAIL", "failed": [details["error"]]}
        failed = []
        for name, condition in checks:
            try:
                holds = condition(details)
            except (KeyError, IndexError, TypeError, StopIteration) as error:
                holds, name = False, f"{name} ({type(error).__name__}: {error})"
            if not holds:
                failed.append(name)
        return {"verdict": "FAIL" if failed else "PASS", "failed": failed}

    tripwire = observed.get("tripwire hits")
    gate = {"html 401": "upstream_unauthorized", "503": "server_unavailable", "403": "upstream_forbidden",
            "stalled /me": "server_unavailable", "302": "endpoint_redirected", "404": "companion_unavailable"}
    coding_denied = ("read token file", "list token directory", "list data root", "read binding.json", "stat control socket", "connect control socket", "create file in data root")
    return {
        1: check(1, [("no DBUS variable in the container", lambda d: d["bus variables"] == []),
                     ("capturing without a session bus", lambda d: d["state"]["state"] == "capturing"),
                     ("a synthetic event uploaded", lambda d: bool(d["uploaded capture"])),
                     ("no keyring, Secret Service or D-Bus log line", lambda d: d["keyring log lines"] == []),
                     ("the session bus tripwire was never dialed", lambda d: tripwire == 0)]),
        2: check(2, [("queued bytes uploaded byte-identically", lambda d: d["byte-identical"]),
                     ("status reports headless capturing", lambda d: (d["headless block"]["mode"], d["headless block"]["state"], d["headless block"]["reason"]) == ("headless", "capturing", "")),
                     ("bound to the configured identity", lambda d: d["headless block"]["binding_id"] == binding_a == d["binding.json"]["binding_id"]),
                     ("no token-named member in status", lambda d: d["token-like keys in status"] == [])]),
        3: check(3, [("401 invalid_device_token holds as credential_rejected", lambda d: d["hold"]["reason"] == "credential_rejected"),
                     ("nothing sent with the rejected file", lambda d: [line for line in next(value for key, value in d.items() if key.startswith("requests in the")) if line.startswith("A ")] == []),
                     ("nothing sent at all while rejected", lambda d: next(value for key, value in d.items() if key.startswith("requests in the")) == []),
                     ("queue retained unchanged", lambda d: d["queue unchanged over the window"] and bool(d["retained on disk"])),
                     ("the replacement resumes the same binding", lambda d: d["resumed binding"] == binding_a == d["binding.json after"]["binding_id"]),
                     ("retained records delivered byte-identically with the new file", lambda d: d["delivered"] and all(item["byte-identical"] and item["label"] == "A2" for item in d["delivered"].values())),
                     ("the rejection is cleared", lambda d: d["admission after"] is None)]),
        4: check(4, [("in-session HTML 401: backoff only", lambda d: set(d["in-session html 401"]["outcomes"]) == {401} and d["in-session html 401"]["state during"]["state"] == "capturing"),
                     ("in-session HTML 401: no admission change", lambda d: d["in-session html 401"]["admission during"] == d["in-session html 401"]["admission before"] is None),
                     ("in-session HTML 401: record kept and later delivered", lambda d: d["in-session html 401"]["still queued"] and bool(d["delivered after"]["capture id"])),
                     ("3xx never followed", lambda d: d["in-session 307"]["tripwire hits since"] == 0 and d["tripwire hits total"] == 0),
                     *[(f"/me {mode} holds as {reason}", lambda d, mode=mode, reason=reason: d["gate"][mode]["state"] == "held" and d["gate"][mode]["reason"] == reason
                        and d["gate"][mode]["held after touch (s)"] >= 0) for mode, reason in gate.items()],
                     ("only /me is sent while held", lambda d: all(item["requests while held"] == ["GET /api/companion/me"] for item in d["gate"].values())),
                     ("no admission change while held", lambda d: all(item["admission"] is None for item in d["gate"].values()))]),
        5: check(5, [("hold within 2.2 s of removal", lambda d: 0 <= d["held after removal (s)"] <= 2.2 and d["hold"]["reason"] == "credential_missing"),
                     ("queue and inbox untouched while held", lambda d: bool(d["queued before removal"]) and d["queue unchanged through the hold"]
                      and d["queue+inbox unchanged over 5s hold"] and bool(d["inbox items while held"])),
                     ("nothing sent while held", lambda d: d["requests while held"] == []),
                     ("restore resumes and delivers queue and inbox", lambda d: d["resumed after restore (s)"] >= 0 and d["queued record delivered byte-identically"]
                      and bool(d["inbox item uploaded"]))]),
        6: check(6, [("the answer was withheld once", lambda d: d["first"]["outcome"] == "dropped"),
                     ("the same bytes were sent again", lambda d: d["first"]["sha256"] == d["second"]["sha256"] and d["first"]["capture_id"] == d["second"]["capture_id"]),
                     ("the server recognized the replay", lambda d: d["second"]["replay"] and not d["second"]["conflict"] and d["second"]["outcome"] == "answered")]),
        7: check(7, [("exit code 0 within the grace period", lambda d: d["exit code"] == 0 and not d["oom killed"] and d["docker stop took (s)"] < 20),
                     ("the drain is bounded near 8 s", lambda d: 7 <= d["docker stop took (s)"] <= 12),
                     ("only uploads after SIGTERM", lambda d: set(d["requests after SIGTERM"]) <= {"POST /api/companion/ingest"}),
                     ("no source read after SIGTERM", lambda d: d["hook during stop answered {}"] and len(d["inbox after exit"]) == 1),
                     ("unacknowledged record retained byte-identically", lambda d: d["retained byte-identically"]),
                     ("delivered byte-identically after start", lambda d: d["delivered byte-identical"] and bool(d["inbox item delivered after restart"]))]),
        8: check(8, [("switch quarantines the old queue byte-identically", lambda d: d["switch"]["quarantine queue byte-identical"] and d["switch"]["binding"] == binding_b),
                     ("nothing from the old ledger reaches the new endpoint", lambda d: d["switch"]["old-ledger records sent to fake B"] == []),
                     ("nothing is flushed to the old endpoint", lambda d: d["switch"]["requests to fake A after switch"] == 0),
                     ("the new binding captures", lambda d: bool(d["switch"]["new capture at B"])),
                     ("switch back delivers the original records to the original endpoint only", lambda d: d["switch back"]["binding"] == binding_a and d["switch back"]["delivered byte-identical"]
                      and not d["switch back"]["S8a ever sent to fake B"] and d["switch back"]["requests to fake B after switch back"] == 0),
                     ("the other binding is quarantined in turn", lambda d: d["switch back"]["quarantine dirs"] == [binding_b])]),
        9: check(9, [("the coding UID reads nothing of the Companion's", lambda d: all(not d["coding uid container"][name]["allowed"] for name in coding_denied)),
                     ("read-only root", lambda d: d["companion container"]["ReadonlyRootfs"] and d["companion process (/proc/1)"]["root mount options"].split(",")[0] == "ro"
                      and all("read-only file system" in item["stderr"] for item in d["root write attempts"].values())),
                     ("no capabilities", lambda d: d["companion container"]["CapDrop"] == ["ALL"] and not d["companion container"]["CapAdd"]
                      and int(d["companion process (/proc/1)"]["CapEff"], 16) == 0 and int(d["companion process (/proc/1)"]["CapPrm"], 16) == 0),
                     ("no-new-privileges", lambda d: "no-new-privileges:true" in d["companion container"]["SecurityOpt"] and d["companion process (/proc/1)"]["NoNewPrivs"] == "1"),
                     ("no Docker socket, host PID or privilege", lambda d: not d["companion process (/proc/1)"]["docker socket mounted"] and d["companion container"]["PidMode"] == ""
                      and not d["companion container"]["Privileged"] and not d["companion container"]["PortBindings"]),
                     ("runs as the Companion UID", lambda d: d["companion process (/proc/1)"]["Uid"].split()[:2] == ["10001", "10001"])]),
        11: check(11, [("the switch-back stopped between quarantine and restore", lambda d: d["hold"]["reason"] == "switch_in_progress" and d["journal while stalled"]["phase"] == "quarantined"
                        and all(count is None for count in d["root queue/inbox/work before status"].values())),
                       ("status inside the container recreated them empty", lambda d: all(count == 0 for count in d["root queue/inbox/work after status (entries)"].values())),
                       ("the switch-back then completed", lambda d: d["binding"] == binding_a and d["journal after"] is None and d["quarantine dirs after"] == [binding_b]),
                       ("the original records reached the original endpoint byte-identically, and only it", lambda d: d["delivered byte-identically to fake A"]
                        and d["ever sent to fake B"] == [] and d["requests to fake B during switch-back"] == 0)]),
        12: check(12, [("held as credential_rejected after the restart", lambda d: d["held after restart"]["reason"] == "credential_rejected"),
                       ("the rejection persisted as file metadata only", lambda d: set(d["persisted rejected file identity (metadata members)"]) <= {"Dev", "Ino", "Size", "MtimeNs", "CtimeNs", "Mode", "UID", "GID"}
                        and bool(d["persisted rejected file identity (metadata members)"])),
                       ("zero requests after the restart", lambda d: next(value for key, value in d.items() if key.startswith("requests to fake A in the")) == []
                        and d["requests to fake B after the restart"] == 0),
                       ("queue retained, then delivered byte-identically after replacement", lambda d: d["queue unchanged through the restart"]
                        and d["retained delivered byte-identically"] and d["resumed binding"] == binding_a)]),
        13: check(13, [("held as token_not_replaced_for_switch", lambda d: d["hold"]["reason"] == "token_not_replaced_for_switch"
                        and d["status headless while held"]["reason"] == "token_not_replaced_for_switch"),
                       ("zero requests to the new origin (and the old) while held", lambda d: next(value for key, value in d.items() if key.startswith("requests to fake B in the")) == []
                        and next(value for key, value in d.items() if key.startswith("requests to fake A in the")) == []),
                       ("nothing switched while held", lambda d: d["binding while held"] == binding_a and binding_a not in d["quarantine while held"]),
                       ("replacing the token lets the switch proceed", lambda d: d["switched binding"] == binding_b and d["quarantine byte-identical"]
                        and "B GET /api/companion/me" in d["requests to fake B after replacement"])]),
        14: check(14, [("pause, resume, projects ignore and agents install refuse", lambda d: all(item["exit"] != 0 and "headless_operator_managed" in item["stderr"] for item in d["cli"].values())),
                       ("every mutating control-API request refuses", lambda d: all(value["error code"] == "headless_operator_managed" for key, value in d["control api"].items()
                                                                                    if key.split(" ")[0] in ("POST", "PATCH", "PUT", "DELETE"))),
                       ("read-only status still answers", lambda d: d["control api"]["GET /v1/status"]["status"] == 200),
                       ("nothing changed and capture continues", lambda d: d["preferences before"] == d["preferences after"] and d["capture state after"] == "active"
                        and bool(d["still uploads"]))]),
        10: check(10, [("the fake has no network", lambda d: d["fake A network"] == "none"),
                       ("the Companion shares only that namespace, where only loopback is up", lambda d: d["joins fake A"] and d["shared namespace probe"]["interfaces up"] == ["lo"]),
                       ("no route out", lambda d: d["shared namespace probe"]["ipv4 routes"] == [] and set(d["shared namespace probe"]["ipv6 route devices"]) <= {"lo"}
                        and d["shared namespace probe"]["dial 1.1.1.1:443"] != "connected"),
                       ("only allowlisted routes were requested", lambda d: d["every request on the headless allowlist"])]),
    }


class Qualification:
    def __init__(self, image, platform, evidence, prefix):
        self.image, self.platform, self.prefix = image, platform, prefix
        self.evidence = evidence
        self.tokens = {"A": new_token(), "A2": new_token(), "A3": new_token(), "B": new_token()}
        # The label of the token fake A currently accepts for installation A.
        self.current_a = "A"
        self.timings = {}
        self.counter = 0
        self.companion = f"{prefix}-companion"
        self.fake_a, self.fake_b = f"{prefix}-fake-a", f"{prefix}-fake-b"
        self.volumes = {"data": f"{prefix}-data", "token": f"{prefix}-token", "config": f"{prefix}-config"}
        self.fakes = {}
        self.binding_a = binding_id(ORIGIN_A, INSTALLATION_A, OWNER)
        self.binding_b = binding_id(ORIGIN_B, INSTALLATION_B, OWNER)

    # -- plumbing ---------------------------------------------------------

    def docker(self, *args, stdin=None, check=True, timeout=180, env=None):
        started = time.time()
        result = subprocess.run(["docker", *args], input=stdin, capture_output=True, timeout=timeout, env=env)
        with (self.evidence / "commands.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"at": stamp(started), "seconds": round(time.time() - started, 3), "argv": ["docker", *args],
                                  "stdin_bytes": len(stdin) if stdin else 0, "exit": result.returncode}) + "\n")
        if check and result.returncode != 0:
            raise QualificationError(f"docker {' '.join(args[:4])} exited {result.returncode}: {result.stderr.decode(errors='replace')[-400:]}")
        return result

    def unique(self, role):
        self.counter += 1
        return f"{self.prefix}-{role}-{self.counter}"

    def compose(self, *args, tripwire=False):
        """The Companion from compose.example.yaml with the qualification
        topology over it; tripwire points a session bus address at fake A's
        tripwire port, so any Secret Service call would be seen dialing it."""
        environment = {key: value for key, value in os.environ.items() if not key.startswith("DBUS_")}
        environment.update(HW02_IMAGE=self.image, HW02_PLATFORM=self.platform, HW02_PREFIX=self.prefix)
        files = ["-f", str(HEADLESS / "compose.example.yaml"), "-f", str(HERE / "compose.qualification.yaml")]
        if tripwire:
            override = self.evidence / "compose.tripwire.yaml"
            override.write_text(json.dumps({"services": {"companion": {"environment": {"DBUS_SESSION_BUS_ADDRESS": f"tcp:host=127.0.0.1,port={TRIPWIRE_PORT}"}}}}), encoding="utf-8")
            files += ["-f", str(override)]
        return self.docker("compose", "-p", self.prefix, *files, *args, env=environment)

    def operator(self, script, stdin=None):
        """Root on the host, as the operator: the token and config volumes
        stand in for the host directories mounted into the Companion."""
        result = self.docker("run", "--rm", "-i", "--name", self.unique("operator"), "--network", "none",
                             "-v", f"{self.volumes['token']}:/token", "-v", f"{self.volumes['config']}:/config",
                             DEBIAN_IMAGE, "sh", "-euc", script, stdin=stdin)
        return result.stdout.decode().strip()

    def data_operator(self, script):
        """Root on the host, acting on the data volume itself (fault injection)."""
        result = self.docker("run", "--rm", "-i", "--name", self.unique("data-operator"), "--network", "none", "--cap-add", "LINUX_IMMUTABLE",
                             "-v", f"{self.volumes['data']}:/data", DEBIAN_IMAGE, "sh", "-euc", script)
        return result.stdout.decode().strip()

    def write_token(self, label):
        """A new file in the token directory, renamed over the path."""
        return float(self.operator("umask 077; cat > /token/.incoming; chown 10001:10001 /token/.incoming; chmod 0400 /token/.incoming;"
                                   " mv -f /token/.incoming /token/device-token; date +%s.%N", stdin=(self.tokens[label] + "\n").encode()))

    def write_config(self, origin, installation_id):
        config = {"endpoint": origin, "token_file": TOKEN_PATH, "installation_id": installation_id, "owner_email": OWNER, "allow_loopback_http": True}
        self.operator("cat > /config/.incoming; chmod 0644 /config/.incoming; mv -f /config/.incoming /config/config.json", stdin=json.dumps(config).encode())

    def control(self, fake, **faults):
        path = self.evidence / fake / "control.json"
        incoming = path.with_suffix(".incoming")
        incoming.write_text(json.dumps(faults), encoding="utf-8")
        os.replace(incoming, path)

    def entries(self, fake):
        path = self.evidence / fake / "requests.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def last_sequence(self, fake):
        return max((entry["seq"] for entry in self.entries(fake)), default=0)

    def requests_after(self, fake, sequence):
        return [entry for entry in self.entries(fake) if entry["event"] == "request" and entry["seq"] > sequence]

    def receipts(self, fake, session):
        return [(entry, record) for entry in self.entries(fake) if entry["event"] == "receipt" for record in entry["records"] if record["session"] == session]

    def outcome(self, fake, sequence):
        return next((entry for entry in self.entries(fake) if entry["event"] == "outcome" and entry["seq"] == sequence), None)

    def tripwire_hits(self):
        path = self.evidence / "fake-a" / "tripwire.jsonl"
        return len(path.read_text().splitlines()) if path.exists() else 0

    def status(self, label=None):
        result = self.docker("exec", "-u", f"{COMPANION_UID}:{COMPANION_UID}", self.companion, EXECUTABLE, "status", check=False)
        document = json.loads(result.stdout or b"{}")
        if label:
            (self.evidence / "status").mkdir(exist_ok=True)
            (self.evidence / "status" / f"{label}.json").write_bytes(result.stdout)
        return document

    def headless(self, label=None):
        return self.status(label).get("headless") or {}

    def hook(self, session):
        payload = {"cwd": MAPPED_ROOT, "session_id": session, "hook_event_name": "SessionStart", "source": "startup"}
        result = self.docker("exec", "-i", "-u", f"{COMPANION_UID}:{COMPANION_UID}", self.companion, EXECUTABLE, "hook", "claude-code",
                             stdin=json.dumps(payload).encode(), check=False)
        return result.returncode == 0 and result.stdout.strip() == b"{}"

    def read_root(self, label=None):
        result = self.docker("run", "--rm", "--name", self.unique("reader"), "--network", "none", "-u", f"{COMPANION_UID}:{COMPANION_UID}",
                             "-v", f"{self.volumes['data']}:/data:ro", PYTHON_IMAGE, "python3", "-I", "-c", READER)
        if label:
            (self.evidence / "data-root").mkdir(exist_ok=True)
            (self.evidence / "data-root" / f"{label}.json").write_bytes(result.stdout)
        return json.loads(result.stdout)

    @staticmethod
    def entries_under(root, prefix):
        return {path: digest for path, digest in root["files"].items() if path.startswith(prefix)}

    @staticmethod
    def queued(root, capture_id, prefix="queue/"):
        return {path: digest for path, digest in root["files"].items() if path.startswith(prefix) and path.endswith(f"-{capture_id}.json")}

    def wait(self, what, condition, timeout=30, interval=0.5):
        deadline = time.time() + timeout
        while True:
            value = condition()
            if value:
                return value
            if time.time() > deadline:
                raise QualificationError(f"timed out after {timeout}s waiting for {what}")
            time.sleep(interval)

    def wait_state(self, state, reason="", timeout=30, binding=None, after=None):
        def reached():
            block = self.headless()
            if (block.get("state") == state and block.get("reason", "") == reason and (binding is None or block.get("binding_id") == binding)
                    and (after is None or go_time(block.get("since", "1970-01-01T00:00:00Z")) >= after)):
                return block
            return None
        return self.wait(f"headless {state}/{reason or '-'}", reached, timeout)

    def companion_logs(self, label):
        result = self.docker("logs", "--timestamps", self.companion, check=False)
        (self.evidence / "logs").mkdir(exist_ok=True)
        (self.evidence / "logs" / f"companion-{label}.log").write_bytes(result.stdout + result.stderr)
        return (result.stdout + result.stderr).decode(errors="replace")

    # -- setup ------------------------------------------------------------

    def setup(self):
        existing = self.docker("ps", "-a", "--filter", f"name=^{self.prefix}-", "--format", "{{.Names}}").stdout.split()
        volumes = self.docker("volume", "ls", "--filter", f"name=^{self.prefix}-", "--format", "{{.Name}}").stdout.split()
        if existing or volumes:
            raise QualificationError(f"leftovers from an earlier run; clean up first: {existing + volumes}")
        for volume in ("token", "config"):
            self.docker("volume", "create", self.volumes[volume])
        self.operator("chown 0:10001 /token; chmod 0750 /token; chmod 0755 /config")
        self.write_token("A")
        self.write_config(ORIGIN_A, INSTALLATION_A)
        self.start_fake(self.fake_a, "fake-a", PORT_A, ["--network", "none"], {"A": INSTALLATION_A, "A2": INSTALLATION_A, "A3": INSTALLATION_A}, TRIPWIRE_PORT)
        self.start_fake(self.fake_b, "fake-b", PORT_B, ["--network", f"container:{self.fake_a}"], {"B": INSTALLATION_B}, 0)

    def start_fake(self, name, directory, port, network, labels, tripwire_port):
        control = self.evidence / directory
        control.mkdir(mode=0o700)
        self.control(directory)
        identities = [{"label": label, "token": self.tokens[label], "installation_id": installation, "owner_email": OWNER} for label, installation in labels.items()]
        argv = ["docker", "run", "-i", "--rm", "--name", name, *network, "-u", "65534:65534", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges:true", "-v", f"{HERE}:/harness:ro", "-v", f"{control}:/control", PYTHON_IMAGE,
                "python3", "-I", "/harness/fake_backplane.py", "--port", str(port), "--tripwire-port", str(tripwire_port), "--control", "/control"]
        with (self.evidence / "commands.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"at": stamp(), "argv": argv, "stdin_bytes": "identities document", "background": True}) + "\n")
        output = (control / "stdout.log").open("wb")
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.STDOUT)
        process.stdin.write(json.dumps({"identities": identities, "mapping_root": MAPPED_ROOT}).encode())
        process.stdin.close()
        self.fakes[name] = process
        self.wait(f"{name} to serve", lambda: b"serving" in (control / "stdout.log").read_bytes(), timeout=60)

    # -- scenarios --------------------------------------------------------

    def scenario_1(self):
        started = time.time()
        self.compose("up", "-d", "--no-build", "companion")
        environment = json.loads(self.docker("inspect", self.companion).stdout)[0]["Config"]["Env"]
        bus_variables = [variable for variable in environment if variable.startswith("DBUS")]
        block = self.wait_state("capturing", timeout=60)
        self.timings["first start to capturing (s)"] = round(time.time() - started, 2)
        hooked = self.hook("hw02-s1")
        receipt = self.wait("the S1 record at fake A", lambda: self.receipts("fake-a", "hw02-s1"), timeout=45)
        self.timings["S1 hook to upload (s)"] = round(receipt[0][0]["at"] - started, 2)
        logs = self.companion_logs("s1-no-bus")
        keyring_lines = [line for line in logs.splitlines() if any(word in line.lower() for word in ("keyring", "secret", "dbus", "credential_store"))]
        self.status("s1-capturing")
        self.compose("rm", "-s", "-f", "companion")
        self.s1 = {"bus variables": bus_variables, "state": block, "hook answered {}": hooked, "uploaded capture": receipt[0][1]["capture_id"], "keyring log lines": keyring_lines}
        return self.s1

    def scenario_2(self):
        mark = self.last_sequence("fake-a")
        self.compose("up", "-d", "--no-build", "companion", tripwire=True)
        self.wait_state("capturing", timeout=60, binding=self.binding_a)
        self.control("fake-a", stall=[INGEST])
        self.hook("hw02-s2")
        arrival = self.wait("the S2 ingest", lambda: next((entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST
                                                             and any(record["session"] == "hw02-s2" for record in entry["records"])), None))
        capture_id = next(record["capture_id"] for record in arrival["records"] if record["session"] == "hw02-s2")
        on_disk = self.queued(self.read_root("s2-queued"), capture_id)
        self.control("fake-a")
        receipt = self.wait("the S2 receipt", lambda: self.receipts("fake-a", "hw02-s2"))
        self.wait("the S2 record to leave the queue", lambda: not self.queued(self.read_root(), capture_id), timeout=30)
        status = self.status("s2-capturing")
        root = self.read_root("s2-after-upload")
        block = status.get("headless", {})
        return {"capture id": capture_id, "queued file sha256": list(on_disk.values()), "received sha256": receipt[0][1]["sha256"],
                "byte-identical": list(on_disk.values()) == [receipt[0][1]["sha256"]], "headless block": block,
                "status keys": sorted(status), "binding.json": root["documents"].get("binding.json"),
                "token-like keys in status": [key for key in json.dumps(status).split('"') if "token" in key.lower()]}

    def scenario_6(self):
        self.control("fake-a", drop_ingest={"id": "s6", "count": 1})
        self.hook("hw02-s6")
        receipts = self.wait("two S6 arrivals", lambda: (found := self.receipts("fake-a", "hw02-s6")) and len(found) >= 2 and found, timeout=60)
        first, second = receipts[0], receipts[1]
        capture_id = first[1]["capture_id"]
        self.wait("the S6 record to leave the queue", lambda: not self.queued(self.read_root(), capture_id), timeout=30)
        self.control("fake-a")
        return {"capture id": capture_id, "first": dict(first[1], outcome=(self.outcome("fake-a", first[0]["seq"]) or {}).get("outcome")),
                "second": dict(second[1], outcome=(self.outcome("fake-a", second[0]["seq"]) or {}).get("outcome")),
                "retransmit gap (s)": round(second[0]["at"] - first[0]["at"], 2)}

    def scenario_4(self):
        details = {}
        html = {"status": 401, "headers": {"Content-Type": "text/html"}, "body": "<html><body><h1>401 Authorization Required</h1></body></html>"}
        before = self.read_root("s4-before")["documents"].get("admission.json")
        mark = self.last_sequence("fake-a")
        hits_before = self.tripwire_hits()
        self.control("fake-a", canned={INGEST: html})
        self.hook("hw02-s4")
        attempts = self.wait("two in-session HTML 401 ingests", lambda: (found := [entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST]) and len(found) >= 2 and found, timeout=40)
        capture_id = attempts[0]["records"][0]["capture_id"]
        block = self.headless("s4-ingest-html401")
        root = self.read_root("s4-ingest-html401")
        details["in-session html 401"] = {"attempt gaps (s)": [round(b["at"] - a["at"], 2) for a, b in zip(attempts, attempts[1:])],
                                          "outcomes": [(self.outcome("fake-a", entry["seq"]) or {}).get("status") for entry in attempts],
                                          "state during": {key: block.get(key) for key in ("state", "reason")},
                                          "admission before": before, "admission during": root["documents"].get("admission.json"),
                                          "still queued": bool(self.queued(root, capture_id))}
        mark = self.last_sequence("fake-a")
        self.control("fake-a", canned={INGEST: {"status": 307, "headers": {"Location": f"http://127.0.0.1:{TRIPWIRE_PORT}/followed"}, "body": ""}})
        redirected = self.wait("an ingest answered 307", lambda: next((entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST
                                                                      and (self.outcome("fake-a", entry["seq"]) or {}).get("status") == 307), None), timeout=60)
        time.sleep(1)
        details["in-session 307"] = {"answered": redirected["seq"], "tripwire hits since": self.tripwire_hits() - hits_before}
        self.control("fake-a")
        delivered = self.wait("the S4 record once ingest answers", lambda: self.receipts("fake-a", "hw02-s4"), timeout=90)
        details["delivered after"] = {"capture id": delivered[0][1]["capture_id"], "admission after": self.read_root()["documents"].get("admission.json")}

        gate = {}
        # Consecutive reasons differ: a hold whose reason is unchanged is not
        # recorded again, so its "since" would predate the touch.
        modes = [
            ("html 401", {"canned": {ME: html}}, "upstream_unauthorized"),
            ("503", {"canned": {ME: {"status": 503, "headers": {"Content-Type": "text/plain"}, "body": "unavailable"}}}, "server_unavailable"),
            ("403", {"canned": {ME: {"status": 403, "body": "{\"detail\":\"Forbidden\"}"}}}, "upstream_forbidden"),
            ("stalled /me", {"stall": [ME]}, "server_unavailable"),
            ("302", {"canned": {ME: {"status": 302, "headers": {"Location": f"http://127.0.0.1:{TRIPWIRE_PORT}/login"}, "body": ""}}}, "endpoint_redirected"),
            ("404", {"canned": {ME: {"status": 404, "body": "{\"detail\":\"Not Found\"}"}}}, "companion_unavailable"),
        ]
        for name, faults, expected in modes:
            self.control("fake-a", **faults)
            mark = self.last_sequence("fake-a")
            touched = float(self.operator("touch /token/device-token; date +%s.%N"))
            try:
                block = self.wait_state("held", expected, timeout=30, after=touched)
                held_after = round(go_time(block["since"]) - touched, 2)
            except QualificationError as error:
                block, held_after = {"error": str(error), **self.headless()}, None
            sent = self.requests_after("fake-a", mark)
            gate[name] = {"expected": expected, "state": block.get("state"), "reason": block.get("reason"), "held after touch (s)": held_after,
                          "requests while held": sorted({f"{entry['method']} {entry['path']}" for entry in sent}),
                          "admission": self.read_root()["documents"].get("admission.json")}
        self.control("fake-a")
        touched = float(self.operator("touch /token/device-token; date +%s.%N"))
        self.wait_state("capturing", timeout=60, after=touched)
        details["gate"] = gate
        details["tripwire hits total"] = self.tripwire_hits()
        self.status("s4-recovered")
        return details

    def scenario_3(self):
        self.control("fake-a", revoked=["A"])
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s3")
        block = self.wait_state("held", "credential_rejected", timeout=60)
        rejected_at = time.time()
        rejections = [entry for entry in self.requests_after("fake-a", mark) if (self.outcome("fake-a", entry["seq"]) or {}).get("outcome") == "unauthorized"]
        first = rejections[0]
        held = self.read_root("s3-rejected")
        retained = self.entries_under(held, "queue/")
        self.status("s3-rejected")
        observe = 40
        time.sleep(observe)
        after = self.requests_after("fake-a", first["seq"])
        held_later = self.read_root("s3-rejected-after-window")
        replaced_at = self.write_token("A2")
        self.current_a = "A2"
        resumed = self.wait_state("capturing", timeout=30, binding=self.binding_a, after=replaced_at)
        retained_ids = {path.rsplit("-", 1)[-1].removesuffix(".json"): digest for path, digest in retained.items()}

        def delivered():
            found = {record["capture_id"]: (entry, record) for entry in self.entries("fake-a") if entry["event"] == "receipt" and entry["seq"] > first["seq"]
                     for record in entry["records"] if record["capture_id"] in retained_ids}
            return found if retained_ids and len(found) == len(retained_ids) else None
        receipts = self.wait("every retained record via A2", delivered, timeout=60)
        labels = {entry["seq"]: entry["label"] for entry in self.entries("fake-a") if entry["event"] == "request"}
        root = self.read_root("s3-resumed")
        self.status("s3-resumed")
        return {"rejecting request": {"seq": first["seq"], "label": first["label"], "method": first["method"], "path": first["path"],
                                      "records": [record["session"] for record in first.get("records", [])]},
                "rejections answered": len(rejections), "hold": {key: block.get(key) for key in ("state", "reason", "binding_id")},
                "admission while held": held["documents"].get("admission.json"), "retained on disk": retained,
                f"requests in the {observe}s after the rejection": [f"{entry['label']} {entry['method']} {entry['path']}" for entry in after],
                "queue unchanged over the window": retained == self.entries_under(held_later, "queue/"),
                "resumed after replacement (s)": round(go_time(resumed["since"]) - replaced_at, 2), "resumed binding": resumed.get("binding_id"),
                "delivered": {capture_id: {"label": labels[entry["seq"]], "sha256": record["sha256"], "byte-identical": record["sha256"] == retained_ids[capture_id]}
                              for capture_id, (entry, record) in receipts.items()},
                "admission after": root["documents"].get("admission.json"), "binding.json after": root["documents"].get("binding.json"),
                "observed for (s)": round(time.time() - rejected_at, 1)}

    def scenario_5(self):
        # A record waits in the queue (ingest answers 503) when the token goes.
        self.control("fake-a", canned={INGEST: {"status": 503, "body": "unavailable"}})
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s5a")
        self.wait("the S5 record held in the queue", lambda: next((entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST
                                                                  and any(record["session"] == "hw02-s5a" for record in entry["records"])), None))
        before = self.read_root("s5-before")
        queued = self.entries_under(before, "queue/")
        removed_at = float(self.operator("rm -f /token/device-token; date +%s.%N"))
        block = self.wait_state("held", "credential_missing", timeout=15, after=removed_at)
        hooked = self.hook("hw02-s5b")
        mark = self.last_sequence("fake-a")
        during = self.read_root("s5-held")
        time.sleep(5)
        later = self.read_root("s5-held-later")
        sent = self.requests_after("fake-a", mark)
        self.control("fake-a")
        restored_at = self.write_token(self.current_a)
        resumed = self.wait_state("capturing", timeout=30, binding=self.binding_a, after=restored_at)
        queued_ids = {path.rsplit("-", 1)[-1].removesuffix(".json"): digest for path, digest in queued.items()}

        def delivered():
            found = {record["capture_id"]: record["sha256"] for entry in self.entries("fake-a") if entry["event"] == "receipt" and entry["seq"] > mark
                     for record in entry["records"] if record["capture_id"] in queued_ids}
            return found if queued_ids and len(found) == len(queued_ids) else None
        receipts = self.wait("the queued S5 record after restore", delivered, timeout=60)
        inbox_item = self.wait("the S5 inbox item uploaded", lambda: self.receipts("fake-a", "hw02-s5b"), timeout=60)
        kept = lambda root: {path: digest for path, digest in root["files"].items() if path.startswith(("queue/", "inbox/"))}
        return {"held after removal (s)": round(go_time(block["since"]) - removed_at, 3), "hold": {key: block.get(key) for key in ("state", "reason")},
                "queued before removal": queued, "queue unchanged through the hold": self.entries_under(later, "queue/") == queued,
                "inbox items while held": sorted(path for path in during["files"] if path.startswith("inbox/")),
                "hook answered {} while held": hooked, "queue+inbox unchanged over 5s hold": kept(during) == kept(later),
                "requests while held": [f"{entry['method']} {entry['path']}" for entry in sent],
                "resumed after restore (s)": round(go_time(resumed["since"]) - restored_at, 3),
                "queued record delivered byte-identically": receipts == queued_ids, "inbox item uploaded": inbox_item[0][1]["capture_id"]}

    def scenario_7(self):
        self.control("fake-a", stall=[INGEST])
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s7a")
        arrival = self.wait("the stalled S7 ingest", lambda: next((entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST
                                                                  and any(record["session"] == "hw02-s7a" for record in entry["records"])), None))
        capture_id = next(record["capture_id"] for record in arrival["records"] if record["session"] == "hw02-s7a")
        queued_before = self.queued(self.read_root("s7-before-stop"), capture_id)
        mark = self.last_sequence("fake-a")
        stop_started = time.time()
        stopping = subprocess.Popen(["docker", "stop", "-t", "20", self.companion], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with (self.evidence / "commands.jsonl").open("a", encoding="utf-8") as log:
            log.write(json.dumps({"at": stamp(stop_started), "argv": ["docker", "stop", "-t", "20", self.companion], "background": True}) + "\n")
        time.sleep(1.5)
        hooked_during_stop = self.hook("hw02-s7b")
        hooked_at = time.time()
        stopping.wait(timeout=60)
        stop_seconds = round(time.time() - stop_started, 2)
        state = json.loads(self.docker("inspect", self.companion).stdout)[0]["State"]
        after_sigterm = self.requests_after("fake-a", mark)
        stopped = self.read_root("s7-stopped")
        self.companion_logs("s7-stopped")
        self.control("fake-a")
        started = time.time()
        self.docker("start", self.companion)
        self.wait_state("capturing", timeout=60, binding=self.binding_a, after=started)
        self.timings["S7 docker start to capturing (s)"] = round(time.time() - started, 2)
        delivered = self.wait("the S7 queued record after restart", lambda: [pair for pair in self.receipts("fake-a", "hw02-s7a") if pair[0]["seq"] > mark], timeout=60)
        later = self.wait("the S7 inbox item after restart", lambda: self.receipts("fake-a", "hw02-s7b"), timeout=60)
        return {"capture id": capture_id, "docker stop took (s)": stop_seconds, "exit code": state["ExitCode"], "oom killed": state["OOMKilled"],
                "requests after SIGTERM": [f"{entry['method']} {entry['path']}" for entry in after_sigterm],
                "hook during stop answered {}": hooked_during_stop, "hook during stop at (s after SIGTERM)": round(hooked_at - stop_started, 2),
                "inbox after exit": sorted(path for path in stopped["files"] if path.startswith("inbox/")),
                "queued before stop": queued_before, "queued after exit": self.queued(stopped, capture_id),
                "retained byte-identically": queued_before == self.queued(stopped, capture_id) and bool(queued_before),
                "delivered after restart sha256": delivered[0][1]["sha256"], "delivered byte-identical": list(queued_before.values()) == [delivered[0][1]["sha256"]],
                "inbox item delivered after restart": later[0][1]["capture_id"]}

    def scenario_8(self):
        self.control("fake-a", canned={INGEST: {"status": 503, "body": "unavailable"}})
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s8a")
        arrival = self.wait("the S8 ingest answered 503", lambda: next((entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST
                                                                       and any(record["session"] == "hw02-s8a" for record in entry["records"])), None))
        capture_id = next(record["capture_id"] for record in arrival["records"] if record["session"] == "hw02-s8a")
        self.docker("stop", "-t", "20", self.companion)
        before = self.read_root("s8-before-switch")
        queue_before = self.entries_under(before, "queue/")
        self.write_config(ORIGIN_B, INSTALLATION_B)
        self.write_token("B")
        mark_a, mark_b = self.last_sequence("fake-a"), self.last_sequence("fake-b")
        started = time.time()
        self.docker("start", self.companion)
        switched = self.wait_state("capturing", timeout=60, binding=self.binding_b, after=started)
        root = self.read_root("s8-switched")
        quarantined = {path.removeprefix(f"quarantine/{self.binding_a}/"): digest for path, digest in root["files"].items() if path.startswith(f"quarantine/{self.binding_a}/queue/")}
        self.hook("hw02-s8b")
        on_b = self.wait("the S8b record at fake B", lambda: self.receipts("fake-b", "hw02-s8b"), timeout=60)
        status_b = self.status("s8-switched")
        sent_b = self.requests_after("fake-b", mark_b)
        sent_a_while_b = self.requests_after("fake-a", mark_a)
        a_ids = {path.rsplit("-", 1)[-1].removesuffix(".json") for path in queue_before}
        b_ingested = {record["capture_id"] for entry in sent_b if entry["path"] == INGEST for record in entry["records"]}
        switched_details = {"binding": switched.get("binding_id"), "quarantine queue byte-identical": quarantined == queue_before and bool(queue_before),
                            "queue before switch": queue_before, "quarantined queue": quarantined,
                            "active queue after switch": self.entries_under(root, "queue/"),
                            "requests to fake B": sorted({f"{entry['label']} {entry['method']} {entry['path']}" for entry in sent_b}),
                            "old-ledger records sent to fake B": sorted(a_ids & b_ingested), "requests to fake A after switch": len(sent_a_while_b),
                            "status quarantined": status_b.get("headless", {}).get("quarantined"), "new capture at B": on_b[0][1]["capture_id"]}

        self.control("fake-a")
        self.docker("stop", "-t", "20", self.companion)
        self.write_config(ORIGIN_A, INSTALLATION_A)
        self.write_token(self.current_a)
        mark_a, mark_b = self.last_sequence("fake-a"), self.last_sequence("fake-b")
        started = time.time()
        self.docker("start", self.companion)
        back = self.wait_state("capturing", timeout=60, binding=self.binding_a, after=started)
        delivered = self.wait("the quarantined S8a record at fake A", lambda: [pair for pair in self.receipts("fake-a", "hw02-s8a") if pair[0]["seq"] > mark_a], timeout=60)
        root_back = self.read_root("s8-switched-back")
        status_back = self.status("s8-switched-back")
        sent_b_after = self.requests_after("fake-b", mark_b)
        all_b = {record["capture_id"] for entry in self.entries("fake-b") if entry["event"] == "request" and entry["path"] == INGEST for record in entry.get("records", [])}
        on_disk = [digest for path, digest in queue_before.items() if path.endswith(f"-{capture_id}.json")]
        back_details = {"binding": back.get("binding_id"), "delivered sha256": delivered[0][1]["sha256"], "delivered byte-identical": on_disk == [delivered[0][1]["sha256"]],
                        "delivered with label": next(entry["label"] for entry in self.entries("fake-a") if entry["event"] == "request" and entry["seq"] == delivered[0][0]["seq"]),
                        "S8a ever sent to fake B": capture_id in all_b, "requests to fake B after switch back": len(sent_b_after),
                        "quarantine dirs": sorted({path.split("/")[1] for path in root_back["files"] if path.startswith("quarantine/")}),
                        "status quarantined": status_back.get("headless", {}).get("quarantined")}
        return {"capture id": capture_id, "binding A": self.binding_a, "binding B": self.binding_b, "switch": switched_details, "switch back": back_details}

    def scenario_12(self):
        """A restart while credential_rejected, with the same token file, sends nothing."""
        self.control("fake-a", revoked=["A", "A2"])
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s12")
        self.wait_state("held", "credential_rejected", timeout=60)
        held = self.read_root("s12-rejected")
        retained = self.entries_under(held, "queue/")
        self.docker("stop", "-t", "20", self.companion)
        stopped = self.read_root("s12-stopped")
        mark_a, mark_b = self.last_sequence("fake-a"), self.last_sequence("fake-b")
        started = time.time()
        self.docker("start", self.companion)
        block = self.wait_state("held", "credential_rejected", timeout=30, after=started)
        self.status("s12-restarted-rejected")
        observe = 40
        time.sleep(observe)
        sent_a, sent_b = self.requests_after("fake-a", mark_a), self.requests_after("fake-b", mark_b)
        later = self.read_root("s12-after-window")
        replaced_at = self.write_token("A3")
        self.current_a = "A3"
        resumed = self.wait_state("capturing", timeout=30, binding=self.binding_a, after=replaced_at)
        retained_ids = {path.rsplit("-", 1)[-1].removesuffix(".json"): digest for path, digest in retained.items()}

        def delivered():
            found = {record["capture_id"]: record["sha256"] for entry in self.entries("fake-a") if entry["event"] == "receipt" and entry["seq"] > mark_a
                     for record in entry["records"] if record["capture_id"] in retained_ids}
            return found if retained_ids and len(found) == len(retained_ids) else None
        receipts = self.wait("the retained S12 record via A3", delivered, timeout=60)
        persisted = stopped["documents"].get("headless.json", {})
        return {"rejecting requests before the restart": len([entry for entry in self.requests_after("fake-a", mark)
                                                              if (self.outcome("fake-a", entry["seq"]) or {}).get("outcome") == "unauthorized"]),
                "persisted rejected file identity (metadata members)": sorted((persisted.get("rejected_token_file") or {}).keys()),
                "held after restart": {key: block.get(key) for key in ("state", "reason", "binding_id")},
                f"requests to fake A in the {observe}s after the restart": [f"{entry['label']} {entry['method']} {entry['path']}" for entry in sent_a],
                "requests to fake B after the restart": len(sent_b), "retained on disk": retained,
                "queue unchanged through the restart": retained == self.entries_under(later, "queue/") and bool(retained),
                "resumed after replacement (s)": round(go_time(resumed["since"]) - replaced_at, 2), "resumed binding": resumed.get("binding_id"),
                "retained delivered byte-identically": receipts == retained_ids}

    def scenario_13(self):
        """A config switch with the token file left as it was holds until the file is replaced."""
        self.control("fake-a", canned={INGEST: {"status": 503, "body": "unavailable"}})
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s13a")
        self.wait("the S13 ingest answered 503", lambda: next((entry for entry in self.requests_after("fake-a", mark) if entry["path"] == INGEST
                                                              and any(record["session"] == "hw02-s13a" for record in entry["records"])), None))
        self.docker("stop", "-t", "20", self.companion)
        before = self.read_root("s13-before-config-edit")
        queue_a = self.entries_under(before, "queue/")
        self.write_config(ORIGIN_B, INSTALLATION_B)
        mark_a, mark_b = self.last_sequence("fake-a"), self.last_sequence("fake-b")
        started = time.time()
        self.docker("start", self.companion)
        block = self.wait_state("held", "token_not_replaced_for_switch", timeout=30, after=started)
        observe = 10
        time.sleep(observe)
        held = self.read_root("s13-held")
        status = self.status("s13-held")
        sent_a, sent_b = self.requests_after("fake-a", mark_a), self.requests_after("fake-b", mark_b)
        replaced_at = self.write_token("B")
        switched = self.wait_state("capturing", timeout=60, binding=self.binding_b, after=replaced_at)
        root = self.read_root("s13-switched")
        prefix = f"quarantine/{self.binding_a}/"
        quarantined = {path.removeprefix(prefix): digest for path, digest in root["files"].items() if path.startswith(prefix + "queue/")}
        self.control("fake-a")
        return {"hold": {key: block.get(key) for key in ("state", "reason", "binding_id")}, "status headless while held": status.get("headless"),
                f"requests to fake B in the {observe}s held": [f"{entry['label']} {entry['method']} {entry['path']}" for entry in sent_b],
                f"requests to fake A in the {observe}s held": [f"{entry['label']} {entry['method']} {entry['path']}" for entry in sent_a],
                "binding while held": (held["documents"].get("binding.json") or {}).get("binding_id"),
                "quarantine while held": sorted({path.split("/")[1] for path in held["files"] if path.startswith("quarantine/")}),
                "switched after replacement (s)": round(go_time(switched["since"]) - replaced_at, 2), "switched binding": switched.get("binding_id"),
                "requests to fake B after replacement": sorted({f"{entry['label']} {entry['method']} {entry['path']}" for entry in self.requests_after("fake-b", mark_b)}),
                "queue before the edit": queue_a, "quarantined queue": quarantined,
                "quarantine byte-identical": quarantined == queue_a and bool(queue_a)}

    def scenario_11(self):
        """A switch-back held between quarantine and restore while a CLI
        command recreates empty inbox/, queue/ and work/, then finished."""
        prefix = f"quarantine/{self.binding_a}/"
        before = self.read_root("s11-before")
        quarantined = {path.removeprefix(prefix): digest for path, digest in before["files"].items() if path.startswith(prefix + "queue/")}
        quarantined_ids = {path.rsplit("-", 1)[-1].removesuffix(".json"): digest for path, digest in quarantined.items()}
        self.docker("stop", "-t", "20", self.companion)
        self.write_config(ORIGIN_A, INSTALLATION_A)
        self.write_token(self.current_a)
        # The restore cannot rename anything out of an immutable directory:
        # the switch stops after the quarantine step, journal in place.
        flags = self.data_operator(f"chattr +i /data/{prefix.rstrip('/')}; lsattr -d /data/{prefix.rstrip('/')}")
        mark_a, mark_b = self.last_sequence("fake-a"), self.last_sequence("fake-b")
        started = time.time()
        self.docker("start", self.companion)
        # Watched through the read-only reader, not status: status reopens
        # the root, and the point is that it is the first to do so.
        def stalled_hold():
            root = self.read_root()
            decided = root["documents"].get("headless.json") or {}
            if decided.get("reason") == "switch_in_progress" and go_time(decided.get("since", "1970-01-01T00:00:00Z")) >= started:
                return decided
            return None
        block = self.wait("the switch-back to stall", stalled_hold, timeout=30)
        stalled = self.read_root("s11-stalled")
        status = self.status("s11-status-during-switch-back")
        recreated = self.read_root("s11-after-status")
        released = self.data_operator(f"chattr -i /data/{prefix.rstrip('/')}; lsattr -d /data/{prefix.rstrip('/')}")
        released_at = time.time()
        back = self.wait_state("capturing", timeout=120, binding=self.binding_a, after=started)

        def delivered():
            found = {record["capture_id"]: record["sha256"] for entry in self.entries("fake-a") if entry["event"] == "receipt" and entry["seq"] > mark_a
                     for record in entry["records"] if record["capture_id"] in quarantined_ids}
            return found if quarantined_ids and len(found) == len(quarantined_ids) else None
        receipts = self.wait("the quarantined S13 record at fake A", delivered, timeout=60)
        after = self.read_root("s11-switched-back")
        all_b = {record["capture_id"] for entry in self.entries("fake-b") if entry["event"] == "request" and entry["path"] == INGEST for record in entry.get("records", [])}
        scoped = ("queue", "inbox", "work")
        return {"immutable": flags, "released": released, "hold": {key: block.get(key) for key in ("state", "reason", "blocked_by")},
                "journal while stalled": stalled["documents"].get("binding-switch.json"),
                "root queue/inbox/work before status": {name: stalled["directories"].get(name) for name in scoped},
                "status exit state": (status.get("headless") or {}).get("reason"),
                "root queue/inbox/work after status (entries)": {name: recreated["directories"].get(name) for name in scoped},
                "quarantine A while stalled": sorted(path for path in stalled["files"] if path.startswith(prefix)),
                "requests to fake A while stalled": sorted({f"{entry['label']} {entry['method']} {entry['path']}" for entry in self.requests_after("fake-a", mark_a) if entry["at"] < released_at}),
                "switch-back completed after release (s)": round(go_time(back["since"]) - released_at, 2), "binding": back.get("binding_id"),
                "journal after": after["documents"].get("binding-switch.json"),
                "quarantine dirs after": sorted({path.split("/")[1] for path in after["directories"] if path.startswith("quarantine/") and path.count("/") >= 1}),
                "quarantined records": quarantined, "delivered byte-identically to fake A": receipts == quarantined_ids,
                "ever sent to fake B": sorted(set(quarantined_ids) & all_b), "requests to fake B during switch-back": len(self.requests_after("fake-b", mark_b))}

    def scenario_14(self):
        """In a bound root, mutating CLI commands and control-API requests refuse."""
        before = self.read_root("s14-before")
        cli = {}
        for command in (["pause"], ["resume"], ["projects", "ignore", MAPPED_ROOT], ["agents", "install", "claude-code"]):
            result = self.docker("exec", "-u", f"{COMPANION_UID}:{COMPANION_UID}", self.companion, EXECUTABLE, *command, check=False)
            cli[" ".join(command)] = {"exit": result.returncode, "stderr": result.stderr.decode(errors="replace").strip()[-200:]}
        api = self.docker("run", "--rm", "--name", self.unique("control-probe"), "--network", "none", "--pid", f"container:{self.companion}",
                          "-u", f"{COMPANION_UID}:{COMPANION_UID}", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                          "-v", f"{self.volumes['data']}:/data", PYTHON_IMAGE, "python3", "-I", "-c", CONTROL_PROBE)
        after = self.read_root("s14-after")
        mark = self.last_sequence("fake-a")
        self.hook("hw02-s14")
        uploaded = self.wait("an upload after the refusals", lambda: self.receipts("fake-a", "hw02-s14"), timeout=60)
        status = self.status("s14-after")
        return {"cli": cli, "control api": json.loads(api.stdout),
                "preferences before": before["documents"].get("preferences.json"), "preferences after": after["documents"].get("preferences.json"),
                "capture state after": (status.get("capture") or {}).get("state"), "still uploads": uploaded[0][1]["capture_id"],
                "requests since": len(self.requests_after("fake-a", mark))}

    def scenario_9(self):
        coding = self.docker("run", "--rm", "--name", self.unique("coding-uid"), "--network", "none", "-u", f"{CODING_UID}:{CODING_UID}",
                             "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                             "-v", f"{self.volumes['token']}:/run/backplane-companion/token:ro", "-v", f"{self.volumes['data']}:{DATA_ROOT}",
                             "-v", f"{self.volumes['config']}:/etc/backplane-companion:ro", PYTHON_IMAGE, "python3", "-I", "-c", ISOLATION)
        inspect = json.loads(self.docker("inspect", self.companion).stdout)[0]
        host = inspect["HostConfig"]
        hardening = {"User": inspect["Config"]["User"], "ReadonlyRootfs": host["ReadonlyRootfs"], "CapDrop": host["CapDrop"], "CapAdd": host["CapAdd"],
                     "SecurityOpt": host["SecurityOpt"], "Privileged": host["Privileged"], "PidMode": host["PidMode"], "IpcMode": host["IpcMode"],
                     "NetworkMode": host["NetworkMode"], "Memory": host["Memory"], "NanoCpus": host["NanoCpus"], "PidsLimit": host["PidsLimit"],
                     "Tmpfs": host["Tmpfs"], "PortBindings": host["PortBindings"], "Devices": host["Devices"],
                     "Mounts": [{key: mount.get(key) for key in ("Type", "Name", "Source", "Destination", "RW")} for mount in inspect["Mounts"]]}
        process = self.docker("run", "--rm", "--name", self.unique("pid-probe"), "--network", "none", "--pid", f"container:{self.companion}",
                              "-u", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", PYTHON_IMAGE, "python3", "-I", "-c", PROCESS_PROBE)
        writes = {}
        for user in ("0:0", f"{COMPANION_UID}:{COMPANION_UID}"):
            # run --log creates the log's directory first: a mkdir on the root filesystem.
            probe = self.docker("exec", "-u", user, self.companion, EXECUTABLE, "run", "--log", "/hw02-write-probe/probe.log", "--headless-config", "relative-refused", check=False)
            writes[f"uid {user}: create /hw02-write-probe/probe.log"] = {"exit": probe.returncode, "stderr": probe.stderr.decode(errors="replace").strip()[-300:]}
        return {"coding uid container": json.loads(coding.stdout), "companion container": hardening, "companion process (/proc/1)": json.loads(process.stdout), "root write attempts": writes}

    def scenario_10(self):
        fake = json.loads(self.docker("inspect", self.fake_a).stdout)[0]["HostConfig"]["NetworkMode"]
        fake_b = json.loads(self.docker("inspect", self.fake_b).stdout)[0]["HostConfig"]["NetworkMode"]
        companion = json.loads(self.docker("inspect", self.companion).stdout)[0]["HostConfig"]["NetworkMode"]
        fake_id = json.loads(self.docker("inspect", self.fake_a).stdout)[0]["Id"]
        probe = self.docker("run", "--rm", "--name", self.unique("netns-probe"), "--network", f"container:{self.fake_a}", "-u", "65534:65534",
                            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", PYTHON_IMAGE, "python3", "-I", "-c", NETNS_PROBE)
        hosts = {entry["path"] for name in ("fake-a", "fake-b") for entry in self.entries(name) if entry["event"] == "request"}
        return {"fake A network": fake, "fake B network": fake_b, "companion network": companion, "joins fake A": companion == f"container:{fake_id}",
                "shared namespace probe": json.loads(probe.stdout), "paths the fakes received": sorted(hosts),
                "every request on the headless allowlist": all(entry["allowed"] for name in ("fake-a", "fake-b") for entry in self.entries(name) if entry["event"] == "request")}

    # -- verdicts ---------------------------------------------------------

    def run(self, selected=None):
        steps = [(1, "No-DBus startup", self.scenario_1), (2, "Valid token", self.scenario_2), (6, "Uncertain acknowledgement", self.scenario_6),
                 (4, "Bare/HTML 401, 3xx, 404, 503", self.scenario_4), (3, "Credential rejection and replacement", self.scenario_3),
                 (12, "Restart while rejected, same token file", self.scenario_12),
                 (5, "Token file removal and restore", self.scenario_5), (7, "Stop/start retention and bounded drain", self.scenario_7),
                 (8, "Config switch and switch back", self.scenario_8), (13, "Config switch without a new token", self.scenario_13),
                 (11, "Switch-back with a CLI recreating empty directories", self.scenario_11),
                 (14, "Mutating CLI and control API refused", self.scenario_14), (9, "Isolation", self.scenario_9), (10, "Egress", self.scenario_10)]
        observed = {}
        for number, title, step in steps:
            if selected and number not in selected:
                continue
            started = time.time()
            try:
                observed[number] = step()
                observed[number]["scenario seconds"] = round(time.time() - started, 1)
            except (QualificationError, subprocess.TimeoutExpired, KeyError, StopIteration, json.JSONDecodeError) as error:
                observed[number] = {"error": f"{type(error).__name__}: {error}", "scenario seconds": round(time.time() - started, 1)}
                self.companion_logs(f"s{number}-error")
            print(f"[{stamp()}] scenario {number} observed in {observed[number]['scenario seconds']}s", flush=True)
            (self.evidence / "observed.json").write_text(json.dumps(observed, indent=2, sort_keys=True, default=str), encoding="utf-8")
        self.companion_logs("final")
        observed["tripwire hits"] = self.tripwire_hits()
        return observed

    def leak_scan(self):
        """Every evidence file, container log, inspect document and the whole
        data root, searched for every form of every token."""
        found = {}
        for path in sorted(self.evidence.rglob("*")):
            if path.is_file():
                hits = find_traces(path.read_bytes(), self.tokens)
                if hits:
                    found[str(path.relative_to(self.evidence))] = hits
        names = self.docker("ps", "-a", "--filter", f"name=^{self.prefix}-", "--format", "{{.Names}}").stdout.decode().split()
        (self.evidence / "inspect").mkdir(exist_ok=True)
        for name in names:
            inspected = self.docker("inspect", name).stdout
            (self.evidence / "inspect" / f"{name}.json").write_bytes(inspected)
            logs = self.docker("logs", name, check=False)
            for where, data in ((f"docker inspect {name}", inspected), (f"docker logs {name}", logs.stdout + logs.stderr)):
                hits = find_traces(data, self.tokens)
                if hits:
                    found[where] = hits
        dump = self.docker("run", "--rm", "--name", self.unique("leak-reader"), "--network", "none", "-u", f"{COMPANION_UID}:{COMPANION_UID}",
                           "-v", f"{self.volumes['data']}:/data:ro", DEBIAN_IMAGE, "tar", "-C", "/data", "-cf", "-", ".").stdout
        hits = find_traces(dump, self.tokens)
        if hits:
            found["data root (every file)"] = hits
        return {"searched": {"evidence files": sum(1 for path in self.evidence.rglob("*") if path.is_file()), "containers": names, "data root bytes": len(dump)},
                "forms": sorted(token_traces("bpc_" + "x" * 43)), "tokens": sorted(self.tokens), "found": found}

    def cleanup(self):
        containers = self.docker("ps", "-a", "--filter", f"name=^{self.prefix}-", "--format", "{{.Names}}").stdout.decode().split()
        volumes = self.docker("volume", "ls", "--filter", f"name=^{self.prefix}-", "--format", "{{.Name}}").stdout.decode().split()
        listing = {"containers": containers, "volumes": volumes, "at": stamp()}
        (self.evidence / "cleanup.json").write_text(json.dumps(listing, indent=2), encoding="utf-8")
        for name in containers:
            if not name.startswith(f"{self.prefix}-"):
                raise QualificationError(f"refusing to remove {name}")
            self.docker("rm", "-f", name, check=False)
        for process in self.fakes.values():
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
        for name in volumes:
            if not name.startswith(f"{self.prefix}-"):
                raise QualificationError(f"refusing to remove {name}")
            self.docker("volume", "rm", name, check=False)
        listing["remaining containers"] = self.docker("ps", "-a", "--filter", f"name=^{self.prefix}-", "--format", "{{.Names}}").stdout.decode().split()
        listing["remaining volumes"] = self.docker("volume", "ls", "--filter", f"name=^{self.prefix}-", "--format", "{{.Name}}").stdout.decode().split()
        (self.evidence / "cleanup.json").write_text(json.dumps(listing, indent=2), encoding="utf-8")
        return listing


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--image", required=True)
    parser.add_argument("--platform", default="linux/amd64")
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--prefix", default="hw-run-hw02")
    parser.add_argument("--keep", action="store_true", help="leave the containers and volumes for inspection")
    parser.add_argument("--cleanup-only", action="store_true", help="list, then remove, the <prefix>-* containers and volumes")
    parser.add_argument("--scenarios", type=lambda value: {int(number) for number in value.split(",")}, help="a subset, e.g. 1,2,6 (they build on each other in order)")
    arguments = parser.parse_args()
    arguments.evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    qualification = Qualification(arguments.image, arguments.platform, arguments.evidence.resolve(), arguments.prefix)
    if arguments.cleanup_only:
        print(json.dumps(qualification.cleanup(), indent=2))
        return 0
    qualification.setup()
    try:
        observed = qualification.run(arguments.scenarios)
    finally:
        scan = qualification.leak_scan()
        (arguments.evidence / "leak-scan.json").write_text(json.dumps(scan, indent=2, sort_keys=True), encoding="utf-8")
        print(json.dumps({"leaks": scan["found"]}), flush=True)
        if not arguments.keep:
            print(json.dumps(qualification.cleanup()), flush=True)
    (arguments.evidence / "timings.json").write_text(json.dumps(qualification.timings, indent=2), encoding="utf-8")
    results = verdicts(observed, qualification.binding_a, qualification.binding_b)
    (arguments.evidence / "verdicts.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    for number, result in sorted(results.items()):
        print(f"scenario {number}: {result['verdict']} {'; '.join(result['failed'])}", flush=True)
    return 0 if not scan["found"] and all(result["verdict"] == "PASS" for number, result in results.items() if not arguments.scenarios or number in arguments.scenarios) else 1


if __name__ == "__main__":
    sys.exit(main())
