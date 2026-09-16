# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SKILL.md manifest: frontmatter parsing and the guidance-vs-hand lint.

The SKILL.md format is an open standard: `name` and `description` are
required, every other key passes through untouched. Backplane defines exactly
ONE key of its own — `toolsets`, an optional list of MCP toolset ids naming
the hand the playbook plays in. Toolsets ENFORCE (the server lists and allows
tools), skills GUIDE: a declaration never restricts tools on any client; it
lets the platform warn when the prose and the hand disagree.

Pure functions only (no DB), so catalog entries can derive their toolsets
from their own frontmatter without importing the service layer.
"""

import re
from dataclasses import dataclass, field

from app.exceptions import ValidationError
from app.services.skills.toolsets import ALL_TOOLS, tools_for_known

TOOLSETS_KEY = "toolsets"

# `mcp__valaris__get_card` or a bare whole-word `get_card`. The prefix rides
# inside the match so the name is not a "word" on its own (`__` is a word
# character); longest names first so the alternation never settles on a
# shorter tool that is a prefix of a longer one.
_TOOL_REFERENCE = re.compile(
    r"\b(?:mcp__valaris__)?("
    + "|".join(re.escape(name) for name in sorted(ALL_TOOLS, key=len, reverse=True))
    + r")\b"
)


@dataclass(frozen=True)
class SkillManifest:
    name: str
    description: str
    toolsets: list[str] = field(default_factory=list)
    raw: dict[str, str] = field(default_factory=dict)


def parse_frontmatter(content: str) -> dict[str, str]:
    """Minimal `key: value` reader for the SKILL.md `---` block.

    Deliberately not PyYAML: it is not a declared backend dependency, and the
    open standard only requires flat name/description here — unknown keys are
    passed through unparsed. The one structure understood beyond scalars is a
    block list (`key:` followed by indented `- item` lines), folded back into
    the comma form so every value stays a string.
    """
    if not content.startswith("---"):
        raise ValidationError("SKILL.md must open with YAML frontmatter")
    parts = content.split("---", 2)
    if len(parts) < 3:
        raise ValidationError("SKILL.md frontmatter is not closed with ---")
    fields: dict[str, str] = {}
    block_list_key: str | None = None
    for line in parts[1].strip().splitlines():
        if line.startswith((" ", "\t")):
            item = line.strip()
            if block_list_key is not None and item.startswith("- "):
                item = item[2:].strip().strip("\"'")
                existing = fields[block_list_key]
                fields[block_list_key] = f"{existing}, {item}" if existing else item
            continue
        block_list_key = None
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip()
            fields[key] = value.strip().strip("\"'")
            if not fields[key]:
                block_list_key = key
    return fields


def _split_toolsets(value: str) -> list[str]:
    """`[cards, notes]`, `cards, notes`, `"cards"`, or `cards` → ids (unvalidated)."""
    inner = value.strip()
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    return [
        item.strip().strip("\"'")
        for item in inner.split(",")
        if item.strip().strip("\"'")
    ]


def parse_manifest(content: str) -> SkillManifest:
    """Syntax only: toolset ids survive unvalidated (validate_manifest owns the 422)."""
    raw = parse_frontmatter(content)
    return SkillManifest(
        name=raw.get("name", ""),
        description=raw.get("description", ""),
        toolsets=_split_toolsets(raw.get(TOOLSETS_KEY, "")),
        raw=raw,
    )


def lint_prose_against_toolsets(files: list[dict], toolsets: list[str]) -> list[str]:
    """Tool names the bundle's prose references outside the declared hand,
    sorted and de-duplicated. Nothing declared ⇒ nothing to check ⇒ []."""
    if not toolsets:
        return []
    allowed = tools_for_known(toolsets)
    referenced: set[str] = set()
    for f in files:
        referenced.update(_TOOL_REFERENCE.findall(f["content"]))
    return sorted(referenced - allowed)
