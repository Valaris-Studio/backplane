# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Spec for the migration's idempotent backfill helper.

The 056 migration walks every note row and rewrites non-canonical content.
This test ensures `_is_canonical` correctly classifies the four shapes the
backfill encounters: canonical PM JSON, legacy markdown, legacy plain text,
empty.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


_MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "alembic"
    / "versions"
    / "056_normalize_note_content.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_056", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["migration_056"] = module
    spec.loader.exec_module(module)
    return module


def test_is_canonical_recognizes_pm_doc():
    mig = _load_migration()
    pm = json.dumps({"type": "doc", "content": []})
    assert mig._is_canonical(pm) is True


def test_is_canonical_rejects_markdown():
    mig = _load_migration()
    assert mig._is_canonical("# Heading") is False


def test_is_canonical_rejects_plain_text():
    mig = _load_migration()
    assert mig._is_canonical("just some words") is False


def test_is_canonical_rejects_non_doc_json():
    mig = _load_migration()
    assert mig._is_canonical(json.dumps({"type": "paragraph"})) is False


def test_is_canonical_rejects_empty_and_none():
    mig = _load_migration()
    assert mig._is_canonical("") is False
    assert mig._is_canonical(None) is False  # type: ignore[arg-type]
