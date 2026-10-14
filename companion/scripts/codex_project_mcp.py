# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT

"""Route a trusted Codex project's legacy valaris alias through Companion.

Python 3.11+. Dry run by default. Requires an exact enabled mapping in agent_access.json
and the expected endpoint. Never reads or edits the global Codex config,
copies a credential, overwrites a foreign MCP entry, or changes other roots.
Restart the project's Codex session after applying the override.
"""

import argparse
import json
import os
import tempfile
import tomllib
from pathlib import Path


def configure(project: Path, launcher: Path, state: dict, endpoint: str, *, apply=False) -> bool:
    project, launcher = project.resolve(strict=True), launcher.resolve(strict=True)
    if state.get("endpoint", "").rstrip("/") != endpoint.rstrip("/"):
        raise ValueError("Companion endpoint does not match the requested environment")
    mappings = [
        value for value in state.get("mappings", {}).values()
        if value.get("enabled") and value.get("board_id") and mapped_root(value) == project
    ]
    if len(mappings) != 1:
        raise ValueError("Project must have exactly one enabled Companion board mapping")
    directory = project / ".codex"
    path = directory / "config.toml"
    if directory.is_symlink() or path.is_symlink():
        raise ValueError("Refusing a symlinked project configuration")
    prepared_from = read_if_present(path)
    original = prepared_from or ""
    config = tomllib.loads(original)
    desired = {"command": str(launcher), "args": ["mcp"], "startup_timeout_sec": 60}
    servers = config.get("mcp_servers", {})
    if servers.get("valaris") == desired and servers.get("backplane") == {"enabled": False}:
        return False
    if "valaris" in servers or "backplane" in servers:
        raise ValueError("Project already defines a Backplane MCP entry; review it explicitly")
    updated = original + ("\n" if original and not original.endswith("\n") else "") + (
        "\n# Project routing through Companion; the global configuration is unchanged.\n"
        "[mcp_servers.valaris]\n"
        f"command = {json.dumps(str(launcher), ensure_ascii=False)}\n"
        'args = ["mcp"]\nstartup_timeout_sec = 60\n\n'
        "# Avoid exposing the same server twice in this project.\n"
        "[mcp_servers.backplane]\nenabled = false\n"
    )
    # Reject TOML representations that cannot be extended, before writing.
    parsed = tomllib.loads(updated)
    assert parsed["mcp_servers"]["valaris"] == desired
    if apply:
        directory.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as file:
            temporary = Path(file.name)
            try:
                file.write(updated)
                file.flush()
                os.fsync(file.fileno())
                # Absence is part of the compared state: a deletion or a newly
                # created (even empty) file is a change like any edit.
                if read_if_present(path) != prepared_from:
                    raise ValueError("Project configuration changed during preparation")
                os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o600)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
    return True


def mapped_root(mapping: dict) -> Path | None:
    # An absent, empty or relative root would resolve against the working directory.
    root = mapping.get("root")
    if not isinstance(root, str) or not root or not Path(root).is_absolute():
        return None
    return Path(root).resolve()


def read_if_present(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--launcher", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    changed = configure(
        args.project, args.launcher, json.loads(args.state.read_text(encoding="utf-8")),
        args.endpoint, apply=args.apply,
    )
    print("configured" if changed and args.apply else "would configure" if changed else "already configured")


if __name__ == "__main__":
    main()
