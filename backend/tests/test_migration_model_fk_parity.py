# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Guard: alembic migrations and the SQLAlchemy models must agree on FKs.

The test suite builds its schema with `Base.metadata.create_all`, never via
migrations — so a migration that diverges from the models (FK missing, wrong
`ondelete`) is invisible to every other test while being exactly what runs in
prod Postgres. This is the class of bug behind the 2026-07-30 deletion 500s.

The check renders every migration in alembic offline (`--sql`) mode against
the postgresql dialect — no database connection — replays the emitted DDL
into a final FK state (child table.column -> parent table, ondelete), and
diffs that against the FK declarations on `Base.metadata`.
"""

from __future__ import annotations

import contextlib
import io
import re
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy.engine.mock import MockConnection

from app.config import settings
from app.models.base import Base

# Registers every model on Base.metadata exactly as the running app does.
import app.main  # noqa: F401

BACKEND_DIR = Path(__file__).resolve().parents[1]

# The suite has ~30 FK-bearing tables; far fewer parsed FKs means the DDL
# parser broke, and the diff would pass vacuously.
MIN_EXPECTED_DB_FKS = 50


class _NullResult:
    rowcount = 0

    def fetchall(self):
        return []

    def fetchone(self):
        return None

    def scalars(self):
        return self

    def all(self):
        return []

    def first(self):
        return None

    def __iter__(self):
        return iter([])


def _tolerant_execute(original):
    # Offline mode hands data-backfill migrations a MockConnection; their
    # SELECTs can't run without a DB, so swallow the failure and hand back an
    # empty result — only the DDL they emit matters here.
    def execute(self, obj, *args, **kwargs):
        try:
            original(self, obj, *args, **kwargs)
        except Exception:
            pass
        return _NullResult()

    return execute


def _render_offline_sql() -> str:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))

    buf = io.StringIO()
    with (
        patch.object(MockConnection, "execute", _tolerant_execute(MockConnection.execute)),
        patch.object(
            MockConnection, "exec_driver_sql", lambda self, *a, **k: _NullResult(), create=True
        ),
        patch.object(MockConnection, "scalar", lambda self, *a, **k: None, create=True),
        # env.py's offline path reads settings.DATABASE_URL; pin the dialect
        # to postgresql regardless of this process's env.
        patch.object(
            settings, "DATABASE_URL", "postgresql+asyncpg://parity:parity@localhost/parity"
        ),
        contextlib.redirect_stdout(buf),
    ):
        command.upgrade(cfg, "head", sql=True)
    return buf.getvalue()


def _norm(identifier: str) -> str:
    return identifier.strip().strip('"').lower()


def _split_top_level_commas(body: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    parts.append(current)
    return parts


_IDENT = r'"?\w+"?'
_FK_CLAUSE = re.compile(
    rf"(?:CONSTRAINT ({_IDENT}) )?FOREIGN KEY\((.*?)\) REFERENCES ({_IDENT}) ?\((.*?)\)(.*)",
    re.I,
)
_ON_DELETE = re.compile(r"ON DELETE (CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)", re.I)


def _parse_migration_fk_state(sql: str) -> dict[str, tuple[str, str | None]]:
    """Replay the DDL stream into {'table.column': (parent_table, ondelete)}."""
    fks: dict[str, tuple[str, str | None]] = {}
    fk_names: dict[str, str | None] = {}

    def record(table: str, cols: str, parent: str, tail: str, name: str | None):
        ondelete = _ON_DELETE.search(tail or "")
        for col in cols.split(","):
            key = f"{table}.{_norm(col)}"
            fks[key] = (parent, ondelete.group(1).upper() if ondelete else None)
            fk_names[key] = _norm(name) if name else None

    for statement in sql.split(";"):
        flat = " ".join(re.sub(r"--.*", "", statement).split())
        if not flat:
            continue

        m = re.match(rf"CREATE TABLE ({_IDENT}) \((.*)\)$", flat, re.I | re.S)
        if m:
            table = _norm(m.group(1))
            for part in _split_top_level_commas(m.group(2)):
                fk = _FK_CLAUSE.match(part.strip())
                if fk:
                    record(table, fk.group(2), _norm(fk.group(3)), fk.group(5), fk.group(1))
            continue

        m = re.match(
            rf"ALTER TABLE ({_IDENT}) ADD (?:CONSTRAINT ({_IDENT}) )?"
            rf"FOREIGN KEY\((.*?)\) REFERENCES ({_IDENT}) ?\((.*?)\)(.*)$",
            flat,
            re.I,
        )
        if m:
            record(_norm(m.group(1)), m.group(3), _norm(m.group(4)), m.group(6), m.group(2))
            continue

        m = re.match(rf"ALTER TABLE ({_IDENT}) ADD COLUMN ({_IDENT}) (.*)$", flat, re.I)
        if m:
            inline = re.search(rf"REFERENCES ({_IDENT}) ?\((.*?)\)(.*)$", m.group(3), re.I)
            if inline:
                record(_norm(m.group(1)), m.group(2), _norm(inline.group(1)), inline.group(3), None)
            continue

        m = re.match(rf"ALTER TABLE ({_IDENT}) DROP CONSTRAINT ({_IDENT})", flat, re.I)
        if m:
            table, name = _norm(m.group(1)), _norm(m.group(2))
            for key in list(fks):
                # Unnamed create-table FKs get Postgres's conventional
                # {table}_{column}_fkey name, so match that as a fallback.
                column = key.split(".", 1)[1]
                if key.startswith(f"{table}.") and (
                    fk_names.get(key) == name or f"{table}_{column}_fkey" == name
                ):
                    del fks[key]
                    del fk_names[key]
            continue

        m = re.match(rf"ALTER TABLE ({_IDENT}) DROP COLUMN ({_IDENT})", flat, re.I)
        if m:
            fks.pop(f"{_norm(m.group(1))}.{_norm(m.group(2))}", None)
            continue

        m = re.match(rf"DROP TABLE ({_IDENT})", flat, re.I)
        if m:
            table = _norm(m.group(1))
            for key in list(fks):
                if key.startswith(f"{table}."):
                    del fks[key]
            continue

    return fks


def _model_fk_state() -> dict[str, tuple[str, str | None]]:
    fks: dict[str, tuple[str, str | None]] = {}
    for table in Base.metadata.sorted_tables:
        for column in table.columns:
            for fk in column.foreign_keys:
                ondelete = fk.ondelete.upper() if fk.ondelete else None
                fks[f"{table.name}.{column.name}"] = (fk.column.table.name, ondelete)
    return fks


def test_migrations_and_models_agree_on_foreign_keys():
    migration_fks = _parse_migration_fk_state(_render_offline_sql())
    model_fks = _model_fk_state()

    assert len(migration_fks) >= MIN_EXPECTED_DB_FKS, (
        f"Only {len(migration_fks)} FKs parsed from the rendered migrations — "
        "the DDL parser is likely broken, which would make this guard vacuous."
    )

    drift: list[str] = []
    for key in sorted(set(model_fks) | set(migration_fks)):
        in_model = model_fks.get(key)
        in_db = migration_fks.get(key)
        if in_db is None:
            drift.append(f"{key}: declared on the model (-> {in_model[0]}) but absent in migrations")
        elif in_model is None:
            drift.append(f"{key}: created by migrations (-> {in_db[0]}) but absent on the model")
        elif in_model[1] != in_db[1]:
            drift.append(
                f"{key}: ondelete differs — model={in_model[1]} migrations={in_db[1]}"
            )

    assert not drift, (
        "Migrations and models disagree on foreign keys (tests run on "
        "create_all, prod runs on migrations — this drift only breaks prod):\n  "
        + "\n  ".join(drift)
    )
