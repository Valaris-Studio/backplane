#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Adapt the canonical valaris-core rulebook into Backplane's starter catalog.

Use a reviewed, committed source bundle and its exact Git revision:

    python scripts/generate-mcp-rulebook-catalog.py \
        --source-dir /path/to/valaris-core/skills/valaris-mcp-rulebook \
        --source-revision <40-character-commit> \
        --output backend/app/services/skills/catalog_entries/mcp_coordination_rulebook.py

Add --check to verify the artifact without writing it. The caller verifies the
source checkout matches the supplied revision; raw file hashes also identify the
exact input bytes. Only catalog frontmatter is adapted. The body and reference
are preserved verbatim; evaluation scenarios are not installed as instructions.
"""

import argparse
import hashlib
import pprint
import re
import sys
from pathlib import Path

CATALOG_ID = "mcp-coordination-rulebook"
CATALOG_VERSION = 7
CATALOG_NAME = "MCP Coordination Rulebook"
CATALOG_DESCRIPTION = (
    "Day-to-day etiquette for coordinating through Backplane MCP — session startup, "
    "entity model, definition-first context, interactive card claiming, notes, "
    "dependencies, write-and-verify; use for everyday work on an existing board."
)
TOOLSETS = (
    "start-here",
    "work-management",
    "knowledge-content",
    "collaboration",
    "autonomous-operations",
)
SOURCE_FILES = ("SKILL.md", "references/tool-map.md")
SOURCE_REPOSITORY = "https://github.com/Valaris-Studio/valaris-methodology"


def adapt_manifest(source: str) -> str:
    frontmatter = re.match(r"\A---\r?\n.*?\r?\n---\r?\n", source, re.DOTALL)
    if frontmatter is None:
        raise ValueError("SKILL.md must begin with YAML frontmatter")
    body = source[frontmatter.end():]
    return (
        f"---\nname: {CATALOG_NAME}\ndescription: {CATALOG_DESCRIPTION}\n"
        f"toolsets: [{', '.join(TOOLSETS)}]\n---\n{body}"
    )


def render_catalog(source_dir: Path, revision: str) -> str:
    raw_files = {name: (source_dir / name).read_bytes() for name in SOURCE_FILES}
    files = {name: content.decode("utf-8") for name, content in raw_files.items()}
    files["SKILL.md"] = adapt_manifest(files["SKILL.md"])
    provenance = {
        "repository": SOURCE_REPOSITORY,
        "revision": revision,
        "files": {
            name: hashlib.sha256(content).hexdigest()
            for name, content in raw_files.items()
        },
    }
    rendered_files = "".join(
        "        CatalogFile(\n"
        f"            path={name!r},\n"
        f"            content={content!r},\n"
        "        ),\n"
        for name, content in files.items()
    )
    return (
        "# Copyright (c) 2026 Valaris Studio\n"
        "# SPDX-License-Identifier: AGPL-3.0-or-later\n\n"
        '"""Generated MCP Coordination Rulebook; do not hand-edit.\n\n'
        "Regenerate with scripts/generate-mcp-rulebook-catalog.py from the\n"
        "canonical bundle identified by SOURCE_PROVENANCE.\n"
        '"""\n\n'
        "from app.services.skills.catalog_types import CatalogEntry, CatalogFile\n\n"
        f"SOURCE_PROVENANCE = {pprint.pformat(provenance, sort_dicts=False)}\n\n"
        "ENTRY = CatalogEntry(\n"
        f"    catalog_id={CATALOG_ID!r},\n"
        f"    catalog_version={CATALOG_VERSION},\n"
        f"    name={CATALOG_NAME!r},\n"
        f"    description={CATALOG_DESCRIPTION!r},\n"
        "    files=(\n"
        f"{rendered_files}"
        "    ),\n"
        ")\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if re.fullmatch(r"[0-9a-fA-F]{40}", args.source_revision) is None:
        parser.error("source revision must be a full 40-character Git commit hash")
    try:
        artifact = render_catalog(args.source_dir, args.source_revision).encode("utf-8")
        if args.check:
            if not args.output.is_file() or args.output.read_bytes() != artifact:
                print(f"Catalog differs from canonical source: {args.output}", file=sys.stderr)
                return 1
            print("Catalog matches canonical source and provenance.")
            return 0
        args.output.write_bytes(artifact)
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))
    print(f"Generated {CATALOG_ID}@{CATALOG_VERSION}: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
