# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pathlib import Path
import re


REPO = Path(__file__).resolve().parents[3]


def test_home_repository_fixture_uses_the_published_repository_identity():
    module = re.search(
        r"^module\s+(\S+)/runner\s*$",
        (REPO / "runner/go.mod").read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    assert module is not None, "runner/go.mod must declare the repository module"
    fixture = (REPO / "frontend/e2e/home-compact-sessions.spec.ts").read_text(encoding="utf-8")
    repository_links = re.findall(r'state\.rows\[\d+\]!\.repository\s*=\s*["\']([^"\']+)["\']', fixture)
    assert repository_links, "the Home fixture must exercise a real repository link"
    assert set(repository_links) == {"https://" + module.group(1)}


def test_headless_compose_repository_references_exist_in_the_distribution():
    example = (REPO / "companion/headless/compose.example.yaml").read_text(encoding="utf-8")
    references = {
        reference.rstrip(".")
        for reference in re.findall(r"(?<![\w/-])(?:companion|integrations)/[A-Za-z0-9_./-]+", example)
    }
    assert references, "the example must retain its source documentation reference"
    missing = sorted(reference for reference in references if not (REPO / reference).exists())
    assert missing == [], f"Compose example refers to files absent from the distribution: {missing}"
