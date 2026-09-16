# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Static guard for a single, unambiguous Alembic revision graph."""

import ast
from pathlib import Path


VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"


def _literal_assignment(path: Path, name: str):
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{path.name} does not assign {name}")


def test_alembic_revision_ids_are_unique_and_have_one_head():
    revisions: dict[str, Path] = {}
    referenced_parents: set[str] = set()

    for path in sorted(VERSIONS.glob("*.py")):
        if path.name == "__init__.py":
            continue
        revision = _literal_assignment(path, "revision")
        assert revision not in revisions, (
            f"duplicate Alembic revision {revision}: "
            f"{revisions[revision].name} and {path.name}"
        )
        revisions[revision] = path

        parent = _literal_assignment(path, "down_revision")
        if isinstance(parent, tuple):
            referenced_parents.update(parent)
        elif parent is not None:
            referenced_parents.add(parent)

    missing = referenced_parents - revisions.keys()
    assert not missing, f"missing Alembic parent revisions: {sorted(missing)}"

    heads = set(revisions) - referenced_parents
    assert heads == {"107"}, f"expected Alembic head 107, got {sorted(heads)}"
