# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

import ast
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
# Receivers whose .open() is a module-level archive/stream opener, not a text open.
_BINARY_OPENERS = {"tarfile", "zipfile", "gzip", "archive"}
_SUBPROCESS_CALLS = {"run", "check_output", "Popen"}
# Text-only helpers with no encoding parameter: use subprocess.run instead.
_LOCALE_ONLY_CALLS = {"getoutput", "getstatusoutput"}
# Binary unless given a text mode (tempfile defaults to "w+b").
_TEMPFILE_CALLS = {"NamedTemporaryFile", "TemporaryFile"}


def _mode(node, keywords, position):
    mode = keywords.get("mode") or (node.args[position] if len(node.args) > position else None)
    return mode.value if isinstance(mode, ast.Constant) else None


def default_encoding_calls(path):
    """Text reads, writes and subprocess pipes in path that fall back to the
    locale encoding (cp1252 on a stock Windows) instead of naming one."""
    found = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not isinstance(node, ast.Call):
            continue
        keywords = {keyword.arg: keyword.value for keyword in node.keywords}
        encoding = keywords.get("encoding")
        # Only a literal name pins it; None or a variable may still mean the locale.
        if isinstance(encoding, ast.Constant) and isinstance(encoding.value, str):
            continue
        function = node.func
        name = function.attr if isinstance(function, ast.Attribute) else getattr(function, "id", None)
        receiver = getattr(function, "value", None)
        if name in ("read_text", "write_text", "TextIOWrapper") or name in _LOCALE_ONLY_CALLS:
            found.append(f"{path.name}:{node.lineno} {name}")
        elif name == "open":
            if isinstance(receiver, ast.Name) and receiver.id in _BINARY_OPENERS:
                continue
            mode = _mode(node, keywords, 0 if isinstance(function, ast.Attribute) else 1)
            if "b" not in (mode or ""):
                found.append(f"{path.name}:{node.lineno} open")
        elif name == "fdopen" and "b" not in (_mode(node, keywords, 1) or ""):
            found.append(f"{path.name}:{node.lineno} fdopen")
        elif name in _TEMPFILE_CALLS and "b" not in (_mode(node, keywords, 0) or "b"):
            found.append(f"{path.name}:{node.lineno} {name}")
        elif name in _SUBPROCESS_CALLS and any(key in keywords for key in ("text", "universal_newlines", "errors", "encoding")):
            found.append(f"{path.name}:{node.lineno} {name}(text=True)")
    return found


class DetectorTest(unittest.TestCase):
    def flagged(self, source):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            return [call.split(" ", 1)[1] for call in default_encoding_calls(path)]

    def test_locale_default_text_io_is_flagged(self):
        self.assertEqual(self.flagged("""
            subprocess.run(command, capture_output=True, errors="replace")
            subprocess.getoutput("go env")
            subprocess.getstatusoutput("go env")
            tempfile.NamedTemporaryFile("w")
            tempfile.TemporaryFile(mode="w+")
            os.fdopen(descriptor)
            io.TextIOWrapper(buffer)
            path.read_text(encoding=None)
            open(path, "w", encoding=chosen)
        """), ["run(text=True)", "getoutput", "getstatusoutput", "NamedTemporaryFile", "TemporaryFile", "fdopen",
               "TextIOWrapper", "read_text", "open"])

    def test_binary_or_utf8_io_is_not_flagged(self):
        self.assertEqual(self.flagged("""
            subprocess.run(command, capture_output=True)
            subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace")
            tempfile.NamedTemporaryFile()
            tempfile.NamedTemporaryFile("w", encoding="utf-8")
            os.fdopen(descriptor, "wb")
            io.TextIOWrapper(buffer, encoding="utf-8")
            open(path, "rb")
            tarfile.open(archive)
        """), [])


class TextEncodingTest(unittest.TestCase):
    def test_scripts_and_their_tests_never_use_the_locale_encoding(self):
        paths = sorted([*SCRIPTS.glob("*.py"), *SCRIPTS.glob("tests/*.py")])
        offenders = [call for path in paths for call in default_encoding_calls(path)]
        self.assertEqual(offenders, [])

    def test_notices_keep_utf8_license_text_under_a_non_utf8_locale(self):
        # Windows defaults to cp1252; C with UTF-8 mode and locale coercion off
        # is the portable stand-in (ASCII, stricter still).
        environment = {key: value for key, value in os.environ.items() if not key.startswith(("LC_", "LANG", "PYTHONIOENCODING"))}
        environment.update(LC_ALL="C", PYTHONUTF8="0", PYTHONCOERCECLOCALE="0")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            license_file = root / "LICENSE"
            license_file.write_bytes("Copyright © 2026 Zoë Ünicode — MIT\n".encode())
            program = textwrap.dedent(f"""
                import sys
                from pathlib import Path
                sys.path.insert(0, {str(SCRIPTS)!r})
                import bundle
                from licenses import Entry
                license_file, stage = Path({str(license_file)!r}), Path({str(root / "stage")!r})
                entries = [Entry("example.com/a", "v1.0.0", ["MIT"], [license_file], ["backplane-companion"])]
                text = bundle.notices(["Header"], entries, {{license_file: "LICENSES/a-LICENSE"}})
                stage.mkdir()
                (stage / "THIRD_PARTY_NOTICES.txt").write_text(text, encoding="utf-8")
                bundle.write_checksums(stage)
                assert bundle.verify_checksums(stage) == []
            """)
            subprocess.run([sys.executable, "-c", program], env=environment, check=True, capture_output=True, timeout=60)
            written = (root / "stage" / "THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
        self.assertIn("Copyright © 2026 Zoë Ünicode — MIT", written)


if __name__ == "__main__":
    unittest.main()
