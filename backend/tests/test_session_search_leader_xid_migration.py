# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""SQLite guard and genuine Alembic lineage for the PostgreSQL-only getter."""

from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, event


SCRIPTS = Path(__file__).resolve().parents[1] / "alembic"


def test_leader_getter_has_real_parent_chain_and_no_sqlite_ddl():
    config = Config()
    config.set_main_option("script_location", str(SCRIPTS))
    script = ScriptDirectory.from_config(config)
    assert script.get_heads() == ["131"]
    assert script.get_revision("131").down_revision == "130"
    revision = script.get_revision("130")
    assert revision.down_revision == "129"
    assert script.get_revision("129").down_revision == "128"
    assert script.get_revision("128").down_revision == "127"
    assert Path(script.get_revision("127").path).name == "127_companion_token_scope.py"
    statements = []
    engine = create_engine("sqlite://")

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        with engine.begin() as connection:
            with Operations.context(MigrationContext.configure(connection)):
                revision.module.upgrade()
                revision.module.downgrade()
    finally:
        engine.dispose()
    assert statements == [], statements
