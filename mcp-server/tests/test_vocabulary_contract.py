# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Vocabulary contract: the credentialed Go process is "a runner", never "a
# runner agent" — the coding agent a runner drives is a different concept and
# never takes the "runner" prefix. This guards every prose surface the MCP
# server ships (tool docstrings, server instructions, rendered prompts)
# against the doubled term reappearing.

from __future__ import annotations

import inspect
import re
from pathlib import Path

from valaris_mcp import prompts as _prompts  # noqa: F401 — registers @mcp.prompt functions
from valaris_mcp.server import mcp

DOUBLED_TERM = re.compile(r"\brunner[- ]agents?\b", re.IGNORECASE)

_DUMMY_ARG = "dummy"


def _prose_surfaces() -> list[tuple[str, str]]:
    surfaces: list[tuple[str, str]] = [("server.py instructions", mcp.instructions or "")]

    for name, tool in sorted(mcp._tool_manager._tools.items()):
        surfaces.append((f"tool {name} docstring", tool.fn.__doc__ or ""))

    # Prompts are functions of str params; render each twice — defaults kept
    # and every param filled — so text behind `if optional_param` branches is
    # scanned either way.
    for name, prompt in sorted(mcp._prompt_manager._prompts.items()):
        params = inspect.signature(prompt.fn).parameters.values()
        required = {p.name: _DUMMY_ARG for p in params if p.default is inspect.Parameter.empty}
        everything = {p.name: _DUMMY_ARG for p in params}
        rendered = {prompt.fn(**required), prompt.fn(**everything)}
        surfaces.append((f"prompt {name}", "\n".join(sorted(rendered))))

    return surfaces


def _offending_lines(surfaces: list[tuple[str, str]]) -> list[str]:
    return list(
        dict.fromkeys(
            f"  {surface}: {line.strip()}"
            for surface, text in surfaces
            for line in text.splitlines()
            if DOUBLED_TERM.search(line)
        )
    )


_DOUBLED_TERM_MESSAGE = (
    "Doubled term 'runner agent(s)' found — say 'runner' alone for the "
    "credentialed process:\n"
)


def test_no_prose_surface_says_runner_agent():
    offenders = _offending_lines(_prose_surfaces())
    assert not offenders, _DOUBLED_TERM_MESSAGE + "\n".join(offenders)


# ---------- frontend docs data + the finalized wire text ----------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_FRONTEND_SRC = _REPO_ROOT / "frontend" / "src"
_MCP_REFERENCE_DATA_DIR = _FRONTEND_SRC / "pages" / "documentation" / "mcp-reference" / "data"
_FRONTEND_PROSE_FILES = (
    _FRONTEND_SRC / "pages" / "documentation" / "sections" / "reference-mcp-tool-catalog.tsx",
    _FRONTEND_SRC / "features" / "agents" / "lib" / "toolCatalog.ts",
)


def _frontend_surfaces() -> list[tuple[str, str]]:
    paths = sorted(_MCP_REFERENCE_DATA_DIR.glob("*.ts")) + list(_FRONTEND_PROSE_FILES)
    return [(str(path.relative_to(_REPO_ROOT)), path.read_text()) for path in paths]


def _wire_surfaces() -> list[tuple[str, str]]:
    # What the model actually reads: the finalized description plus every
    # per-parameter description, not the raw docstring.
    surfaces: list[tuple[str, str]] = []
    for name, tool in sorted(mcp._tool_manager._tools.items()):
        surfaces.append((f"tool {name} wire description", tool.description or ""))
        for param, spec in tool.parameters.get("properties", {}).items():
            surfaces.append((f"tool {name} param {param}", spec.get("description") or ""))
    return surfaces


def test_frontend_surfaces_are_readable():
    # Guards the sweep itself: a moved file would otherwise false-green.
    surfaces = _frontend_surfaces()
    assert len(surfaces) > 10
    assert all(text for _, text in surfaces)


def test_no_frontend_docs_surface_says_runner_agent():
    offenders = _offending_lines(_frontend_surfaces())
    assert not offenders, _DOUBLED_TERM_MESSAGE + "\n".join(offenders)


def test_no_wire_surface_says_runner_agent():
    offenders = _offending_lines(_wire_surfaces())
    assert not offenders, _DOUBLED_TERM_MESSAGE + "\n".join(offenders)
