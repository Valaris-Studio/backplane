# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The public GSAP licensing text must match the vendor's current terms and the
code's actual GSAP footprint.

`THIRD_PARTY_LICENSES.md` ships in the public export and is the one place that
explains Backplane's single non-OSI dependency. It went stale twice at once:
it still described GSAP "paid tiers" after Webflow made GSAP free for every
use (sole exclusion: a no-code animation tool competing with Webflow), and its
"Building without GSAP" recipe claimed one module was the only GSAP consumer
while a dozen-plus components import `gsap` directly.

The direct-importer count is derived from the frontend tree here rather than
pinned as a literal, so the recipe cannot drift again without this test going
red.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LICENSES_DOC = REPO_ROOT / "THIRD_PARTY_LICENSES.md"
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"

_SECOND_LEVEL_HEADING = re.compile(r"^## ", re.MULTILINE)
_DIRECT_GSAP_IMPORT = re.compile(r"""from ["']gsap(/[^"']*)?["']""")
_DOCUMENTED_IMPORTER_COUNT = re.compile(
    r"(\d+)\s+(?:non-test\s+)?(?:files|components|modules)\s+import\s+(?:from\s+)?[`']?gsap",
    re.IGNORECASE,
)
_ISO_DATE_2026 = re.compile(r"\b2026-\d{2}-\d{2}\b")


def _gsap_section() -> str:
    text = LICENSES_DOC.read_text(encoding="utf-8")
    headings = [m.start() for m in _SECOND_LEVEL_HEADING.finditer(text)]
    for index, start in enumerate(headings):
        heading_line = text[start:].splitlines()[0]
        if "GSAP" in heading_line:
            end = headings[index + 1] if index + 1 < len(headings) else len(text)
            return text[start:end]
    raise AssertionError("THIRD_PARTY_LICENSES.md has no '## ' heading mentioning GSAP")


def _is_test_path(path: Path) -> bool:
    relative = path.relative_to(REPO_ROOT).as_posix()
    return "__tests__/" in relative or ".test." in relative


def _direct_gsap_importers() -> list[Path]:
    candidates = [
        path
        for suffix in ("*.ts", "*.tsx")
        for path in FRONTEND_SRC.rglob(suffix)
        if not _is_test_path(path)
    ]
    return sorted(
        path
        for path in candidates
        if _DIRECT_GSAP_IMPORT.search(path.read_text(encoding="utf-8"))
    )


def test_gsap_section_has_no_paid_tier_claim():
    section = _gsap_section()
    assert "paid tier" not in section.lower(), (
        "GSAP section still claims paid tiers exist; GSAP is free for all users under Webflow"
    )
    assert "sell to end users" not in section, (
        "GSAP section still describes a 'sell to end users' exclusion that no longer exists"
    )


def test_gsap_section_states_webflow_free_terms_with_exclusion_and_date():
    section = _gsap_section()
    lowered = section.lower()
    assert "Webflow" in section, "GSAP section does not attribute the current terms to Webflow"
    assert "free" in lowered, "GSAP section does not say GSAP is free"
    assert "https://gsap.com/standard-license" in section, (
        "GSAP section does not link the Standard License"
    )
    assert "no-code" in lowered and "compet" in lowered, (
        "GSAP section does not name the single exclusion "
        "(a no-code visual animation tool that competes with Webflow)"
    )
    assert _ISO_DATE_2026.search(section), (
        "GSAP section carries no ISO verification date (YYYY-MM-DD) for when the terms were checked"
    )


def test_gsap_section_removal_recipe_is_honest():
    section = _gsap_section()
    assert "only place GSAP" not in section, (
        "recipe still claims animations.ts is the only place GSAP is used"
    )
    assert "not GSAP itself" not in section, (
        "recipe still claims component call sites do not import GSAP itself"
    )
    assert _DOCUMENTED_IMPORTER_COUNT.search(section), (
        "recipe does not state how many files import gsap directly "
        "(expected a sentence like '14 non-test files import from `gsap`')"
    )


def test_gsap_section_direct_importer_count_matches_tree():
    section = _gsap_section()
    match = _DOCUMENTED_IMPORTER_COUNT.search(section)
    assert match, "GSAP section has no parseable direct-importer count"
    documented_count = int(match.group(1))
    live_importers = _direct_gsap_importers()
    assert documented_count == len(live_importers), (
        f"THIRD_PARTY_LICENSES.md says {documented_count} files import gsap directly, "
        f"but frontend/src has {len(live_importers)}: "
        + ", ".join(p.relative_to(REPO_ROOT).as_posix() for p in live_importers)
    )


def test_gsap_section_keeps_exception_and_non_osi_pins():
    section = _gsap_section()
    assert "deliberate" in section, "GSAP section no longer frames the dependency as a deliberate exception"
    assert "OSI" in section, "GSAP section no longer identifies the package as non-OSI"


def test_direct_importer_scan_finds_the_known_consumers():
    importers = {p.relative_to(REPO_ROOT).as_posix() for p in _direct_gsap_importers()}
    assert "frontend/src/lib/animations.ts" in importers
    assert "frontend/src/pages/Dashboard.tsx" in importers
    assert not any("__tests__" in path or ".test." in path for path in importers), (
        f"scanner leaked test files: {sorted(p for p in importers if '__tests__' in p or '.test.' in p)}"
    )
