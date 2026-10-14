# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Server-side twin of the companion's PlaceEvent (companion/internal/privacy).

Home-path literals are assembled at runtime: the public export refuses them
in source, case-insensitively.
"""

import pytest

from app.core.local_paths import place_event, place_value

MAC = "/" + "Users/"
MAC_UPPER = "/" + "USERS/"
MAC_LOWER = "/" + "users/"
WIN = "C:\\" + "Users\\"
ROOTS = ["/home/me/code/app", "/home/me/link/app"]


def test_event_keeps_no_local_path():
    event = {
        "session": {"id": "s1", "working_directory": "/home/me/code/app/cmd/server"},
        "file": {"path": "/home/me/code/app/main.go"},
        "tool": {"path": "/home/me/.claude/settings.json"},
        "transcript_path": "/home/me/.claude/projects/app/s1.jsonl",
        "command": {"line": "cd /home/me/code/app && ls /home/me/link/app/docs/"},
        "prompt": {
            "text": "read /home/me/code/app/README.md, /home/me/code/app2/x, "
            + MAC
            + "meadow/y, /home/meadow/q, /home/bob/z, "
            + WIN
            + "Eve\\w and file:///home/me/notes.txt"
        },
        "list": ["/home/me/code/app", "/home/me/code/app/", 3.0],
        "other": "/opt/tools/bin/tool",
    }
    placed = place_event(event, ROOTS)
    assert placed == {
        "session": {"id": "s1", "working_directory": "cmd/server"},
        "file": {"path": "main.go"},
        "tool": {"path": "~me/.claude/settings.json"},
        "transcript_path": "~me/.claude/projects/app/s1.jsonl",
        "command": {"line": "cd . && ls docs/"},
        "prompt": {
            "text": "read README.md, ~me/code/app2/x, ~meadow/y, ~meadow/q, ~bob/z, "
            "~Eve\\w and file://~me/notes.txt"
        },
        "list": [".", "./", 3.0],
        "other": "/opt/tools/bin/tool",
    }
    assert event["file"]["path"] == "/home/me/code/app/main.go"  # input untouched


def test_windows_roots_and_extended_paths():
    root = WIN + "me\\app"
    placed = place_event(
        {
            "session": {"working_directory": root + "\\src"},
            "text": "edit " + root + "\\src\\main.go and " + WIN + "me\\Desktop\\a.txt",
            "long": "\\\\?\\" + WIN + "me\\Documents\\x",
            "other_drive": "D:\\" + "users\\ann\\y",
        },
        [root],
    )
    assert placed["session"]["working_directory"] == "src"
    assert placed["text"] == "edit src\\main.go and ~me\\Desktop\\a.txt"
    assert placed["long"] == "~me\\Documents\\x"
    assert placed["other_drive"] == "~ann\\y"


def test_member_names_are_placed_too():
    placed = place_event(
        {"files": {"/home/me/code/app/main.go": 1, "/home/me/notes.txt": 2}}, ROOTS
    )
    assert placed == {"files": {"main.go": 1, "~me/notes.txt": 2}}


@pytest.mark.parametrize(
    "text,expected",
    [
        (MAC_UPPER + "ann/x", "~ann/x"),
        (MAC_LOWER + "ann/x", "~ann/x"),
        ("/root/.ssh/config", "~root/.ssh/config"),
        # In prose /root and URL-encoded homes are left as they are.
        ("cd /root", "cd /root"),
        ("cp /root/a /root,/root", "cp /root/a /root,/root"),
        ("/var/home/ann/x", "~ann/x"),
        ("a=%2FUsers%2Fann%2Fx", "a=~ann%2Fx"),
        ("%2Fhome%2Fann%2Fx", "~ann%2Fx"),
        ("/rooted/x", "/rooted/x"),
        ("/srv/root/x", "/srv/root/x"),
        ("https://h" + MAC_LOWER + "ann/x", "https://h" + MAC_LOWER + "ann/x"),
    ],
)
def test_other_home_spellings(text, expected):
    assert place_event({"t": text}, [])["t"] == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        # A whole value that is a path is trimmed and file:// URLs are parsed
        # before anchoring, so neither hides a local path.
        (" " + MAC + "me/code/app/x ", "~me/code/app/x"),
        ("file://" + MAC + "me/code", "~me/code"),
        ("file:///home/me/code/app/src", "src"),
        ("file:///C:/" + "Users/me/x", "~me/x"),
        ("file:///home/me/My%20Code", "~me/My Code"),
        ("  /home/me/code/app  ", "."),
        # Prose keeps its spacing; only the paths inside change.
        ("  see " + MAC + "me/x  ", "  see ~me/x  "),
    ],
)
def test_whole_path_values_are_trimmed_and_file_urls_parsed(value, expected):
    assert place_value(value, ["/home/me/code/app"]) == expected


@pytest.mark.parametrize(
    "text",
    [
        "GET /" + "users/42/profile",
        "see /home/about",
        "https://h/" + "Users/ann/x",
        "ratio C:\\" + "users is a word",
    ],
)
def test_prose_web_routes_and_words_are_not_rewritten(text):
    assert place_value(text, []) == text


@pytest.mark.parametrize(
    "value,expected",
    [
        ("/mnt/c/" + "Users/ann/x", "~ann/x"),
        ("see /mnt/d/" + "Users/ann/x now", "see ~ann/x now"),
        ("/" + "users/ann/x", "~ann/x"),  # whole-value paths stay case-insensitive
        ("run /" + "Users/ann/.ssh/config", "run ~ann/.ssh/config"),
        ("in /home/ann/x", "in ~ann/x"),
    ],
)
def test_wsl_and_prose_home_forms(value, expected):
    assert place_value(value, []) == expected


@pytest.mark.parametrize(
    "text,expected",
    [
        ("edit " + "c:\\" + "USERS\\ann\\x.txt now", "edit ~ann\\x.txt now"),
        ("edit " + "D:/" + "Users/ann/x.txt now", "edit ~ann/x.txt now"),
        (
            "open file://laptop/" + "Users/ann/x please",
            "open file://laptop/~ann/x please",
        ),
        ("got a=%2F" + "Users%2Fann%2Fx here", "got a=~ann%2Fx here"),
        ("got a=%2Fhome%2Fann%2Fx here", "got a=~ann%2Fx here"),
        ("in /mnt/c/" + "users/ann/x now", "in ~ann/x now"),
        ("in /MNT/C/" + "USERS/ann/x now", "in ~ann/x now"),
        ("the home is " + "C:\\" + "Users\\ann", "the home is ~ann"),
        ("see file://server/home/ann/x", "see file://server/~ann/x"),
        ("q=%2F" + "Users%2Fann%2Fx&y", "q=~ann%2Fx&y"),
        ("q=%2fvar%2fhome%2fann%2fx", "q=~ann%2fx"),
        ("not " + "C:\\" + "Users\\ann%20x", "not ~ann%20x"),
    ],
)
def test_prose_rewrites_forms_that_cannot_be_web_routes(text, expected):
    assert place_value(text, []) == expected


@pytest.mark.parametrize(
    "text",
    [
        # Accepted gaps: a bare home without a further segment, and lowercase
        # /users/... which web routes use.
        "cd /home/bob",
        "GET /" + "users/ann/profile",
    ],
)
def test_prose_accepted_gaps_are_left_as_they_are(text):
    assert place_value(text, []) == text
