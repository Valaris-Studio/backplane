# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Canonical source changes must survive the catalog's metadata adapter."""

import hashlib
from pathlib import Path
import runpy
import subprocess
import sys

import pytest

from app.services.skills.skill_service import validate_manifest


GENERATOR = (
    Path(__file__).resolve().parents[4] / "scripts/generate-mcp-rulebook-catalog.py"
)
SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567"
CANONICAL_BODY = (
    "\n# Portable rulebook\n\nRead `get_card(include_context=True)` before work.\n"
)
REFERENCE_BODY = '# Tool map\n\nQuoted "text", a backslash \\, and Unicode café.\n'
EXPECTED_TOOLSETS = {
    "start-here",
    "work-management",
    "knowledge-content",
    "collaboration",
    "autonomous-operations",
}


@pytest.fixture
def canonical_source(tmp_path: Path) -> Path:
    source = tmp_path / "canonical-source"
    (source / "references").mkdir(parents=True)
    (source / "SKILL.md").write_text(
        "---\n"
        "name: valaris-mcp-rulebook\n"
        "description: Portable source description for existing board coordination.\n"
        "---\n" + CANONICAL_BODY
    )
    (source / "references/tool-map.md").write_text(REFERENCE_BODY)
    (source / "evals").mkdir()
    (source / "evals/scenarios.md").write_text(
        "Evaluation-only material is not installed.\n"
    )
    return source


def _generate(source: Path, output: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--source-dir",
            str(source),
            "--source-revision",
            SOURCE_REVISION,
            "--output",
            str(output),
            *extra,
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


def _load_generated(source: Path, output: Path) -> dict:
    result = _generate(source, output)
    assert result.returncode == 0, result.stderr or result.stdout
    return runpy.run_path(str(output))


def _files(entry) -> dict[str, str]:
    return {file.path: file.content for file in entry.files}


def _source_hashes(source: Path) -> dict[str, str]:
    return {
        name: hashlib.sha256((source / name).read_bytes()).hexdigest()
        for name in ("SKILL.md", "references/tool-map.md")
    }


def test_generator_adapts_metadata_without_rewriting_source_body_or_references(
    canonical_source: Path, tmp_path: Path
):
    generated = _load_generated(canonical_source, tmp_path / "generated.py")
    entry = generated["ENTRY"]
    files = _files(entry)

    assert entry.catalog_id == "mcp-coordination-rulebook"
    assert entry.catalog_version == 7
    assert entry.name == "MCP Coordination Rulebook"
    assert 1 <= len(entry.description) <= 300
    assert set(entry.toolsets) == EXPECTED_TOOLSETS
    assert set(files) == {"SKILL.md", "references/tool-map.md"}
    assert files["SKILL.md"].split("---\n", 2)[2] == CANONICAL_BODY
    assert files["references/tool-map.md"] == REFERENCE_BODY
    manifest = validate_manifest(
        [{"path": path, "content": content} for path, content in files.items()]
    )
    assert manifest.name == entry.name
    assert manifest.description == entry.description
    provenance = generated["SOURCE_PROVENANCE"]
    assert provenance["revision"] == SOURCE_REVISION
    assert provenance["files"] == _source_hashes(canonical_source)


def test_generation_is_identical_for_same_source_at_different_paths(
    canonical_source: Path, tmp_path: Path
):
    import shutil

    relocated = tmp_path / "another-checkout"
    shutil.copytree(canonical_source, relocated)
    first = tmp_path / "first.py"
    second = tmp_path / "second.py"
    _load_generated(canonical_source, first)
    _load_generated(relocated, second)

    assert first.read_bytes() == second.read_bytes()
    assert str(tmp_path) not in first.read_text()
    assert _generate(canonical_source, first, "--check").returncode == 0


def test_source_mutation_changes_installed_content_and_provenance_and_check_is_read_only(
    canonical_source: Path, tmp_path: Path
):
    output = tmp_path / "generated.py"
    original = _load_generated(canonical_source, output)
    original_bytes = output.read_bytes()
    (canonical_source / "SKILL.md").write_text(
        (canonical_source / "SKILL.md").read_text() + "\nNew source-only instruction.\n"
    )
    (canonical_source / "references/tool-map.md").write_text(
        REFERENCE_BODY + "\nNew source-only evidence.\n"
    )

    check = _generate(canonical_source, output, "--check")
    assert check.returncode != 0, "--check must detect stale installed content"
    assert output.read_bytes() == original_bytes, "--check must not update the artifact"

    updated = _load_generated(canonical_source, output)
    assert _files(updated["ENTRY"]) != _files(original["ENTRY"])
    assert _files(updated["ENTRY"])["SKILL.md"].endswith(
        "New source-only instruction.\n"
    )
    assert _files(updated["ENTRY"])["references/tool-map.md"].endswith(
        "New source-only evidence.\n"
    )
    assert updated["SOURCE_PROVENANCE"]["files"] == _source_hashes(canonical_source)
    assert updated["SOURCE_PROVENANCE"] != original["SOURCE_PROVENANCE"]
    assert _generate(canonical_source, output, "--check").returncode == 0


def test_check_missing_artifact_does_not_create_it(
    canonical_source: Path, tmp_path: Path
):
    output = tmp_path / "missing.py"
    result = _generate(canonical_source, output, "--check")
    assert result.returncode != 0
    assert not output.exists()


def test_invalid_source_revision_preserves_existing_output(
    canonical_source: Path, tmp_path: Path
):
    output = tmp_path / "generated.py"
    _load_generated(canonical_source, output)
    before = output.read_bytes()
    result = _generate(
        canonical_source, output, "--source-revision", "dirty-working-tree"
    )
    assert result.returncode != 0
    assert "revision" in (result.stderr + result.stdout).lower()
    assert output.read_bytes() == before


def test_shipped_rulebook_records_reproducible_source_provenance():
    from app.services.skills.catalog_entries import mcp_coordination_rulebook

    assert mcp_coordination_rulebook.ENTRY.catalog_version == 7
    provenance = getattr(mcp_coordination_rulebook, "SOURCE_PROVENANCE", None)
    assert provenance is not None, "Bundled rulebook must identify its canonical source"
    assert len(provenance["revision"]) == 40
    int(provenance["revision"], 16)
    assert set(provenance["files"]) == {"SKILL.md", "references/tool-map.md"}
    for digest in provenance["files"].values():
        assert len(digest) == 64
        int(digest, 16)
