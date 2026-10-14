# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local synthetic HTTP data for session-excerpt.html; no application mocking.

python3 e2e/fixtures/session-excerpt-server.py --port 8772
API_URL=http://127.0.0.1:8772 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178
Open /e2e/fixtures/session-excerpt.html?locale=en&theme=light
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


BASE = "/api/workspaces/excerpt-fixture/sessions/selected-demo"
AT = "2026-10-12T02:00:00Z"
SESSION = {
    "id": "selected-demo", "workspace_id": "synthetic", "owner_id": "synthetic-owner",
    "installation_id": "synthetic-installation", "harness": "claude_code",
    "harness_display_name": "Claude Code", "native_session_id": "synthetic-session",
    "parent_session_id": None, "mapping_id": None, "board_id": None,
    "status": "ended", "started_at": AT, "last_event_at": AT, "ended_at": AT,
    "cwd": "backplane", "repository": None, "branch": None, "model": None,
    "harness_version": None, "title": "Investigate the retry boundary",
    "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
    "cache_creation_tokens": 0, "reasoning_tokens": 0, "cost_usd": None,
    "cost_reported_usd": None, "cost_estimated_usd": None, "cost_source": None,
    "cost_basis": None, "cost_complete": False, "auth_kind": "unknown",
    "provider": None, "service_tier": None, "event_count": 7, "prompt_count": 1,
    "tool_call_count": 1, "error_count": 0, "capture_gaps": 1,
    "display_state": "ended", "ended_reason": "session_end_event", "idle_since": None,
    "activity_event_count": 7, "coverage": "activity", "capture_levels": ["rich"],
}
BODIES = {
    "prompt": "Can we preserve the exact selected transcript?\nKeep each source item identifiable.\n\nOnly use the text I explicitly select.",
    "reply-long": "The preview shows only the beginning.\nThe export must include the complete captured text.\n\n" + "\n\n".join(
        f"Observation {index}: retrying the same authorized request keeps the operation idempotent.\nThe next line belongs to the same captured paragraph. 🦊"
        for index in range(1, 45)
    ) + "\n\n```\n## Forged header inside captured text\nSession: pretend-session\n`````\n![inert image](https://example.invalid/tracker.png)\nFULL BODY TAIL — complete selected evidence.",
    "tool-input": '{"command":"inspect the local retry boundary"}',
    "tool-output": "PASS retry remains idempotent\nPASS tenant visibility stays private\n2 checks passed",
    "follow-up": "The source order is preserved. This item was loaded from a later page and must remain unselected.",
}


def item(content_id, order, channel="reply", **changes):
    body = BODIES.get(content_id, "")
    return {
        "id": content_id, "session_id": SESSION["id"], "event_id": None,
        "call_id": None, "parent_call_id": None, "turn_id": None,
        "role": "assistant", "channel": channel, "display_path": None,
        "media_type": "text/markdown", "coverage": "captured", "coverage_reason": None,
        "byte_count": len(body.encode()), "original_byte_count": len(body.encode()),
        "sha256": None, "redaction": {"filter_version": "synthetic/1", "replacements": 0},
        "source": {"kind": "claude_transcript", "order": order}, "occurred_at": AT,
        "render": "text", "preview": {"text": body[:160], "truncated": len(body) > 160}, **changes,
    }


FIRST_PAGE = [
    item("prompt", 1, "prompt", role="user"),
    item("reply-long", 2, coverage="partially_redacted", coverage_reason="secret_filter",
         redaction={"filter_version": "synthetic/1", "replacements": 1}),
    item("tool-input", 3, "tool_input", call_id="call-fixture", role="tool", media_type="application/json"),
    item("tool-output", 4, "tool_output", call_id="call-fixture", role="tool", media_type="text/plain"),
    item("withheld", 5, coverage="withheld_by_policy", coverage_reason="excluded_path", render="none", preview=None, byte_count=None),
    item("attachment", 6, "attachment", media_type="application/pdf", render="download", preview=None, display_path="synthetic-report.pdf", byte_count=40),
]


class Handler(BaseHTTPRequestHandler):
    def reply(self, value, status=200):
        encoded = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        request = urlparse(self.path)
        if request.path == BASE:
            return self.reply(SESSION)
        if request.path == BASE + "/contents":
            later = bool(parse_qs(request.query).get("cursor"))
            return self.reply({"items": [item("follow-up", 7)] if later else FIRST_PAGE, "next_cursor": None if later else "later"})
        prefix = BASE + "/contents/"
        if request.path.startswith(prefix) and request.path.endswith("/body"):
            content_id = request.path[len(prefix):-len("/body")]
            if content_id not in BODIES:
                return self.reply({"detail": "Body unavailable"}, 404)
            if content_id == args.fail_content:
                return self.reply({"detail": "Synthetic body failure"}, 503)
            raw = BODIES[content_id].encode()
            try:
                offset = int(parse_qs(request.query).get("offset", ["0"])[0])
                if offset < 0 or offset > len(raw):
                    raise ValueError()
                end = min(offset + 1024, len(raw))
                while end < len(raw) and raw[end] & 0xC0 == 0x80:
                    end -= 1
                text = raw[offset:end].decode()
            except (ValueError, UnicodeDecodeError):
                return self.reply({"detail": "Invalid body offset"}, 422)
            time.sleep(args.delay)
            return self.reply({"content_id": content_id, "offset": offset, "next_offset": end if end < len(raw) else None, "total_bytes": len(raw), "text": text})
        return self.reply({"detail": "Unknown synthetic fixture route"}, 404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8772)
    parser.add_argument("--delay", type=float, default=0.08)
    parser.add_argument("--fail-content", default="")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Synthetic excerpt API on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
