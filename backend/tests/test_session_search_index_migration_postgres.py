# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Native migration serialization and concurrent-index recovery contracts.

Uses the explicitly disposable SESSION_CAPTURE_TEST_DATABASE_URL server.
Each case owns a fresh database and real Alembic CLI subprocesses. Temporary
revision barriers and an executed-SQL recorder observe the current runner;
they do not replace its locking, transaction or version-discovery behavior.

The 128 cases use independently specified index names and canonical predicates.
They are required native migration contracts; selecting their shapes does not
constitute a passing qualification result.
"""

import asyncio
import configparser
import json
import os
import re
import sys
import textwrap
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from tests.test_session_content_postgres import database_url

pytestmark = [pytest.mark.slow, pytest.mark.timeout(120)]
BACKEND = Path(__file__).resolve().parents[1]
BASE_REVISION = "uxc_runner_base"
NEXT_REVISION = "uxc_runner_next"


@dataclass(frozen=True)
class IndexSpec:
    name: str
    table: str
    keys: tuple[str, ...]
    include: tuple[str, ...]
    predicate: str | None = None


# Independent migration contract; do not derive expected shapes from a build.
NONPENDING_CONTENT = (
    "((content_id IS NOT NULL) AND ((status)::text <> 'pending'::text))"
)
RETIRED_INDEXES = (
    "ix_session_search_sources_identity_metadata",
    "ix_agent_session_contents_search_readable",
)

SELECTED_INDEXES: tuple[IndexSpec, ...] = (
    IndexSpec(
        "ix_session_search_chunks_metadata",
        "session_search_chunks",
        ("session_id", "source_id"),
        ("owned_bytes", "channel"),
    ),
    IndexSpec(
        "ix_session_search_sources_content_metadata",
        "session_search_sources",
        ("session_id", "content_id"),
        (),
        NONPENDING_CONTENT,
    ),
    IndexSpec(
        "ix_agent_session_contents_search_metadata",
        "agent_session_contents",
        ("session_id", "id", "sha256"),
        (
            "state",
            "coverage",
            "media_type",
            "byte_count",
            "original_byte_count",
            "channel",
        ),
    ),
    IndexSpec(
        "ix_agent_session_contents_search_session",
        "agent_session_contents",
        ("session_id", "id"),
        (),
    ),
    IndexSpec(
        "ix_session_search_sources_event_metadata",
        "session_search_sources",
        ("session_id", "id"),
        ("status", "extractor_version", "event_id", "call_anchor"),
        "(event_id IS NOT NULL)",
    ),
    IndexSpec(
        "ix_session_search_sources_indexed_metadata",
        "session_search_sources",
        ("status", "extractor_version", "content_id"),
        ("source_digest", "id"),
    ),
)


def _identifier(value):
    assert re.fullmatch(r"[a-z_][a-z_0-9]*", value), value
    return '"' + value + '"'


def _records(path):
    if not path.exists():
        return []
    lines = path.read_text().splitlines()
    result = []
    for index, line in enumerate(lines):
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            if index != len(lines) - 1:
                raise
    return result


def _version_reads(records):
    return [
        item
        for item in records
        if item["sql"].lstrip().upper().startswith("SELECT")
        and "alembic_version" in item["sql"]
        and "version_num" in item["sql"]
    ]


async def _eventually(observe, description, timeout=30):
    try:
        async with asyncio.timeout(timeout):
            while True:
                value = await observe()
                if value:
                    return value
                await asyncio.sleep(0.025)
    except TimeoutError as error:
        raise AssertionError(f"Timed out waiting for {description}") from error


@dataclass
class Command:
    process: asyncio.subprocess.Process
    log: Path
    trace: Path

    async def finish(self, expected=0):
        async with asyncio.timeout(120):
            code = await self.process.wait()
        assert code == expected, self.log.read_text()[-12000:]
        return code


@dataclass
class MigrationDatabase:
    url: str
    name: str
    engine: AsyncEngine
    directory: Path
    commands: list[Command] = field(default_factory=list)

    async def cli(self, *args, config=None, role=None, before_stamp=False):
        tag = role or uuid.uuid4().hex
        log = self.directory / f"{tag}.log"
        trace = self.directory / f"{tag}-sql.jsonl"
        hook = self.directory / "hooks"
        hook.mkdir(exist_ok=True)
        (hook / "sitecustomize.py").write_text(SQL_RECORDER)
        paths = [str(hook), str(BACKEND)]
        if os.environ.get("PYTHONPATH"):
            paths.append(os.environ["PYTHONPATH"])
        environment = {
            **os.environ,
            "DATABASE_URL": self.url,
            "PYTHONPATH": os.pathsep.join(paths),
            "UXC_MIGRATION_SQL_TRACE": str(trace),
            "UXC_MIGRATION_BARRIERS": str(self.directory),
            "UXC_MIGRATION_ROLE": tag,
            "UXC_MIGRATION_BEFORE_STAMP": "1" if before_stamp else "0",
        }
        command = [sys.executable, "-m", "alembic"]
        if config is not None:
            command.extend(["-c", str(config)])
        with log.open("wb") as output:
            process = await asyncio.create_subprocess_exec(
                *command,
                *args,
                cwd=BACKEND,
                env=environment,
                stdout=output,
                stderr=asyncio.subprocess.STDOUT,
            )
        result = Command(process, log, trace)
        self.commands.append(result)
        return result

    def release(self, role, phase):
        (self.directory / f"{role}-{phase}.release").touch()

    async def marker(self, role, phase):
        path = self.directory / f"{role}-{phase}.json"

        async def observe():
            if path.exists():
                return json.loads(path.read_text())
            command = next(item for item in self.commands if item.log.stem == role)
            assert command.process.returncode is None, command.log.read_text()[-12000:]
            return None

        return await _eventually(observe, f"{role} reaching {phase}")

    async def version(self):
        async with self.engine.connect() as connection:
            return await connection.scalar(
                text("SELECT version_num FROM alembic_version")
            )


SQL_RECORDER = textwrap.dedent("""\
    import json
    import os
    from pathlib import Path
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    @event.listens_for(Engine, "before_cursor_execute")
    def record(connection, cursor, statement, parameters, context, many):
        driver = connection.connection.driver_connection
        entry = {"pid": driver.get_server_pid(), "sql": statement}
        with Path(os.environ["UXC_MIGRATION_SQL_TRACE"]).open("a") as output:
            output.write(json.dumps(entry) + "\\n")
        normalized = statement.lstrip().upper()
        if (os.environ.get("UXC_MIGRATION_BEFORE_STAMP") == "1"
                and normalized.startswith("UPDATE")
                and "ALEMBIC_VERSION" in normalized):
            os._exit(91)
    """)


RUNNER_REVISION = textwrap.dedent("""\
    import json
    import os
    import time
    from pathlib import Path
    from alembic import op

    revision = "uxc_runner_next"
    down_revision = "uxc_runner_base"
    branch_labels = None
    depends_on = None

    def mark(phase):
        connection = op.get_bind()
        pid = connection.exec_driver_sql("SELECT pg_backend_pid()").scalar_one()
        locks = connection.exec_driver_sql(
            "SELECT classid::bigint,objid::bigint,objsubid FROM pg_locks "
            "WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted"
        ).all()
        lock_timeout = connection.exec_driver_sql("SHOW lock_timeout").scalar_one()
        root = Path(os.environ["UXC_MIGRATION_BARRIERS"])
        target = root / (os.environ["UXC_MIGRATION_ROLE"] + "-" + phase + ".json")
        temporary = target.with_suffix(".writing")
        temporary.write_text(json.dumps({"pid":pid,"locks":[list(row) for row in locks],
                                         "lock_timeout":lock_timeout}))
        temporary.replace(target)

    def barrier(phase):
        mark(phase)
        root = Path(os.environ["UXC_MIGRATION_BARRIERS"])
        release = root / (os.environ["UXC_MIGRATION_ROLE"] + "-" + phase + ".release")
        deadline = time.monotonic() + 30
        while not release.exists():
            if time.monotonic() > deadline:
                raise RuntimeError("fixture barrier was not released: " + phase)
            time.sleep(0.025)

    def upgrade():
        barrier("entered")
        with op.get_context().autocommit_block():
            mark("autocommit_before")
            op.execute("CREATE INDEX CONCURRENTLY uxc_runner_payload ON uxc_runner_items(payload)")
            barrier("autocommit_after")
        mark("transaction_after")

    def downgrade():
        with op.get_context().autocommit_block():
            op.execute("DROP INDEX CONCURRENTLY uxc_runner_payload")
    """)


@pytest.fixture
async def migration_database(tmp_path):
    server = make_url(database_url())
    assert server.host in {
        "127.0.0.1",
        "localhost",
        "::1",
    }, "Disposable local PostgreSQL only"
    name = "uxc_index_migration_" + uuid.uuid4().hex[:12]
    admin = create_async_engine(server, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(
            text(
                f"CREATE DATABASE {_identifier(name)} TEMPLATE template0 "
                "ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
            )
        )
    url = server.set(database=name).render_as_string(hide_password=False)
    database = MigrationDatabase(url, name, create_async_engine(url), tmp_path)
    try:
        yield database
    finally:
        for command in database.commands:
            if command.process.returncode is None:
                command.process.terminate()
                try:
                    async with asyncio.timeout(10):
                        await command.process.wait()
                except TimeoutError:
                    command.process.kill()
                    await command.process.wait()
        await database.engine.dispose()
        try:
            async with admin.connect() as connection:
                await connection.execute(text(f"DROP DATABASE {_identifier(name)}"))
        finally:
            await admin.dispose()


@pytest.fixture
async def runner(migration_database):
    database = migration_database
    scripts = database.directory / "runner_scripts"
    (scripts / "versions").mkdir(parents=True)
    (scripts / "env.py").write_bytes((BACKEND / "alembic/env.py").read_bytes())
    (scripts / "versions/base.py").write_text(
        f'revision="{BASE_REVISION}"\ndown_revision=None\n'
        "branch_labels=None\ndepends_on=None\n"
        "def upgrade(): pass\ndef downgrade(): pass\n"
    )
    (scripts / "versions/next.py").write_text(RUNNER_REVISION)
    config = configparser.ConfigParser(interpolation=None)
    config.read(BACKEND / "alembic.ini")
    config["alembic"]["script_location"] = str(scripts)
    path = database.directory / "runner.ini"
    with path.open("w") as output:
        config.write(output)
    async with database.engine.begin() as connection:
        await connection.execute(
            text("CREATE TABLE alembic_version(version_num varchar(32) PRIMARY KEY)")
        )
        await connection.execute(
            text("INSERT INTO alembic_version VALUES (:version)"),
            {"version": BASE_REVISION},
        )
        await connection.execute(
            text(
                "CREATE TABLE uxc_runner_items(id integer PRIMARY KEY,payload integer NOT NULL)"
            )
        )
        await connection.execute(
            text("INSERT INTO uxc_runner_items VALUES (1,11),(2,22),(3,33)")
        )
    return database, path


async def _competitor_waits_before_version_read(database, command, holder_pid):
    async def observe():
        records = _records(command.trace)
        if _version_reads(records):
            return "read_version_before_lock"
        if command.process.returncode is not None:
            return "exited_before_lock"
        if not records:
            return None
        async with database.engine.connect() as connection:
            blocked = await connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks waiter JOIN pg_locks holder "
                    "ON waiter.locktype=holder.locktype AND waiter.database=holder.database "
                    "AND waiter.classid=holder.classid AND waiter.objid=holder.objid "
                    "AND waiter.objsubid=holder.objsubid "
                    "WHERE waiter.locktype='advisory' AND NOT waiter.granted "
                    "AND holder.granted AND waiter.pid=:waiter AND holder.pid=:holder)"
                ),
                {"waiter": records[-1]["pid"], "holder": holder_pid},
            )
            if blocked:
                return "blocked"
            attempts = [
                item for item in records if "pg_try_advisory_lock(" in item["sql"]
            ]
            if len(attempts) >= 2:
                # Safe polling must release the snapshot between attempts:
                # a waiting transaction can deadlock a concurrent index build.
                polling_without_transaction = await connection.scalar(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity waiter "
                        "WHERE waiter.pid=:waiter AND waiter.state='idle' "
                        "AND waiter.xact_start IS NULL) AND EXISTS "
                        "(SELECT 1 FROM pg_locks WHERE pid=:holder "
                        "AND locktype='advisory' AND granted)"
                    ),
                    {"waiter": records[-1]["pid"], "holder": holder_pid},
                )
                if polling_without_transaction:
                    return "blocked"
        return None

    outcome = await _eventually(observe, "competing migration runner to block")
    assert outcome == "blocked", (
        f"Competing CLI {outcome}; it must acquire migration ownership before "
        f"reading the schema revision. Executed SQL: {_records(command.trace)!r}"
    )


async def test_competing_cli_reads_version_only_after_first_upgrade_commits(runner):
    database, config = runner
    first = await database.cli("upgrade", "head", config=config, role="first")
    entered = await database.marker("first", "entered")
    second = await database.cli("upgrade", "head", config=config, role="second")
    await _competitor_waits_before_version_read(database, second, entered["pid"])
    database.release("first", "entered")
    database.release("first", "autocommit_after")
    await first.finish()
    await second.finish()
    assert await database.version() == NEXT_REVISION
    assert not (
        database.directory / "second-entered.json"
    ).exists(), "The waiting runner replayed a migration selected before its predecessor committed"
    assert _version_reads(
        _records(second.trace)
    ), "The waiter must refresh the committed version"


async def test_one_session_holds_migration_lock_across_concurrent_ddl(runner):
    database, config = runner
    command = await database.cli("upgrade", "head", config=config, role="owner")
    snapshots = [await database.marker("owner", "entered")]
    database.release("owner", "entered")
    snapshots.append(await database.marker("owner", "autocommit_before"))
    snapshots.append(await database.marker("owner", "autocommit_after"))
    database.release("owner", "autocommit_after")
    await command.finish()
    snapshots.append(await database.marker("owner", "transaction_after"))
    assert len({snapshot["pid"] for snapshot in snapshots}) == 1
    assert {snapshot["lock_timeout"] for snapshot in snapshots} == {"0"}
    common_locks = set.intersection(
        *[{tuple(lock) for lock in snapshot["locks"]} for snapshot in snapshots]
    )
    assert common_locks, f"No migration lock survived the DDL commits: {snapshots!r}"
    async with database.engine.connect() as connection:
        assert (
            await connection.scalar(
                text(
                    "SELECT indisvalid AND indisready FROM pg_index "
                    "WHERE indexrelid='uxc_runner_payload'::regclass"
                )
            )
            is True
        )
        assert (
            await connection.scalar(
                text(
                    "SELECT count(*) FROM pg_locks WHERE pid=:pid AND locktype='advisory'"
                ),
                {"pid": snapshots[0]["pid"]},
            )
            == 0
        )
        assert (
            await connection.execute(text("SELECT * FROM uxc_runner_items ORDER BY id"))
        ).all() == [(1, 11), (2, 22), (3, 33)]


async def test_waiter_recovers_when_its_migration_holder_process_dies(runner):
    database, config = runner
    first = await database.cli("upgrade", "head", config=config, role="lost")
    entered = await database.marker("lost", "entered")
    second = await database.cli("upgrade", "head", config=config, role="survivor")
    await _competitor_waits_before_version_read(database, second, entered["pid"])
    first.process.terminate()  # Only the subprocess created by this fixture.
    async with asyncio.timeout(10):
        await first.process.wait()
    await database.marker("survivor", "entered")
    assert await database.version() == BASE_REVISION
    database.release("survivor", "entered")
    database.release("survivor", "autocommit_after")
    await second.finish()
    assert await database.version() == NEXT_REVISION


async def test_migration_lock_honors_tighter_timeout_without_discovering_version(
    runner,
):
    database, config = runner
    # Applies only to subsequent connections to this fixture-owned database.
    async with database.engine.begin() as connection:
        await connection.execute(
            text(
                f"ALTER DATABASE {_identifier(database.name)} SET lock_timeout='100ms'"
            )
        )
    first = await database.cli("upgrade", "head", config=config, role="timeout_owner")
    entered = await database.marker("timeout_owner", "entered")
    second = await database.cli("upgrade", "head", config=config, role="timed_out")
    async with asyncio.timeout(5):
        await second.finish(expected=1)
    assert not _version_reads(_records(second.trace))
    assert not (database.directory / "timed_out-entered.json").exists()
    assert "timeout" in second.log.read_text().lower()
    assert await database.version() == BASE_REVISION
    database.release("timeout_owner", "entered")
    database.release("timeout_owner", "autocommit_after")
    await first.finish()
    assert (
        entered["lock_timeout"] == "100ms"
    ), "Acquisition must not change migration timeouts"
    # The failed acquisition must not strand ownership or prevent the next CLI.
    third = await database.cli("upgrade", "head", config=config, role="after_timeout")
    await third.finish()
    assert await database.version() == NEXT_REVISION


async def test_failed_transactional_migration_rolls_back_ddl_and_version(runner):
    database, config = runner
    revision = database.directory / "runner_scripts/versions/next.py"
    original = revision.read_text()
    revision.write_text(
        original[: original.index("def upgrade():")]
        + textwrap.dedent("""\
        def upgrade():
            op.execute("CREATE TABLE uxc_rolled_back(id integer)")
            raise RuntimeError("intentional transactional migration failure")

        def downgrade(): pass
        """)
    )
    failed = await database.cli(
        "upgrade", "head", config=config, role="failed_transaction"
    )
    await failed.finish(expected=1)
    assert "intentional transactional migration failure" in failed.log.read_text()
    assert await database.version() == BASE_REVISION
    async with database.engine.connect() as connection:
        assert (
            await connection.scalar(text("SELECT to_regclass('uxc_rolled_back')"))
            is None
        )
    revision.write_text(original)
    next_run = await database.cli(
        "upgrade", "head", config=config, role="after_failure"
    )
    await database.marker("after_failure", "entered")
    database.release("after_failure", "entered")
    database.release("after_failure", "autocommit_after")
    await next_run.finish()
    assert await database.version() == NEXT_REVISION


@pytest.fixture
def selected_indexes():
    assert len(SELECTED_INDEXES) == 6
    assert len({item.name for item in SELECTED_INDEXES}) == 6
    return SELECTED_INDEXES


@pytest.fixture
async def selected_database(selected_indexes, migration_database):
    command = await migration_database.cli("upgrade", "127")
    await command.finish()
    return migration_database, selected_indexes


async def _index_catalog(database, name):
    async with database.engine.connect() as connection:
        row = (
            (
                await connection.execute(
                    text(
                        "SELECT relation.oid,relation.relkind::text AS relkind,"
                        "relation.relpersistence::text AS relpersistence,parent.relname AS table_name,method.amname,"
                        "index.indisvalid,index.indisready,index.indislive,index.indisunique,index.indisprimary,"
                        "index.indisreplident,index.indisclustered,relation.reloptions,"
                        "pg_get_expr(index.indpred,index.indrelid) AS predicate,"
                        "ARRAY(SELECT pg_get_indexdef(index.indexrelid,position,false) "
                        "FROM generate_series(1,index.indnkeyatts) position ORDER BY position) AS key_definitions,"
                        "ARRAY(SELECT option.bits::integer FROM unnest(index.indoption) WITH ORDINALITY option(bits,position) "
                        "ORDER BY option.position) AS key_options,"
                        "ARRAY(SELECT key.class_oid::bigint FROM unnest(index.indclass) WITH ORDINALITY key(class_oid,position) "
                        "ORDER BY key.position) AS opclass_oids,"
                        "ARRAY(SELECT namespace.nspname::text FROM unnest(index.indclass) WITH ORDINALITY key(class_oid,position) "
                        "JOIN pg_opclass opclass ON opclass.oid=key.class_oid "
                        "JOIN pg_namespace namespace ON namespace.oid=opclass.opcnamespace "
                        "ORDER BY key.position) AS opclass_schemas,"
                        "ARRAY(SELECT opclass.opcname::text FROM unnest(index.indclass) WITH ORDINALITY key(class_oid,position) "
                        "JOIN pg_opclass opclass ON opclass.oid=key.class_oid "
                        "ORDER BY key.position) AS opclass_names,"
                        "ARRAY(SELECT opclass.opcdefault FROM unnest(index.indclass) WITH ORDINALITY key(class_oid,position) "
                        "JOIN pg_opclass opclass ON opclass.oid=key.class_oid "
                        "ORDER BY key.position) AS opclass_defaults,"
                        "ARRAY(SELECT attribute.attname FROM unnest(index.indkey) WITH ORDINALITY key(attnum,position) "
                        "JOIN pg_attribute attribute ON attribute.attrelid=index.indrelid AND attribute.attnum=key.attnum "
                        "WHERE key.position<=index.indnkeyatts ORDER BY key.position) AS keys,"
                        "ARRAY(SELECT attribute.attname FROM unnest(index.indkey) WITH ORDINALITY key(attnum,position) "
                        "JOIN pg_attribute attribute ON attribute.attrelid=index.indrelid AND attribute.attnum=key.attnum "
                        "WHERE key.position>index.indnkeyatts ORDER BY key.position) AS included,"
                        "pg_get_indexdef(index.indexrelid) AS definition "
                        "FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace "
                        "LEFT JOIN pg_index index ON index.indexrelid=relation.oid "
                        "LEFT JOIN pg_class parent ON parent.oid=index.indrelid "
                        "LEFT JOIN pg_am method ON method.oid=relation.relam "
                        "WHERE namespace.nspname='public' AND relation.relname=:name"
                    ),
                    {"name": name},
                )
            )
            .mappings()
            .one_or_none()
        )
        return dict(row) if row else None


async def _assert_selected(database, specifications):
    key_opclasses = {
        "session_id": "uuid_ops",
        "source_id": "uuid_ops",
        "content_id": "uuid_ops",
        "id": "uuid_ops",
        "status": "text_ops",
        "extractor_version": "text_ops",
        "source_digest": "bpchar_ops",
        "sha256": "bpchar_ops",
    }
    found = {}
    for spec in specifications:
        row = await _index_catalog(database, spec.name)
        assert row is not None, spec
        assert (row["relkind"], row["table_name"], row["amname"]) == (
            "i",
            spec.table,
            "btree",
        )
        assert tuple(row["keys"]) == spec.keys
        # Selected keys retain default ASC/NULLS LAST btree semantics.
        # Per-column pg_get_indexdef omits ordering/opclass details on PostgreSQL16.
        assert tuple(row["key_options"]) == (0,) * len(spec.keys)
        assert tuple(row["opclass_schemas"]) == ("pg_catalog",) * len(spec.keys)
        expected_opclasses = tuple(key_opclasses[key] for key in spec.keys)
        assert tuple(row["opclass_names"]) == expected_opclasses
        assert tuple(row["opclass_defaults"]) == (True,) * len(spec.keys)
        assert row["relpersistence"] == "p"
        assert tuple(row["included"]) == spec.include
        assert row["predicate"] == spec.predicate
        assert row["indisvalid"] and row["indisready"] and row["indislive"]
        assert not row["indisunique"] and not row["indisprimary"]
        assert not row["indisreplident"] and not row["indisclustered"]
        assert row["reloptions"] is None
        found[spec.name] = row
    for name in RETIRED_INDEXES:
        assert await _index_catalog(database, name) is None, name
    return found


async def _constraints(database):
    async with database.engine.connect() as connection:
        return (
            await connection.execute(
                text(
                    "SELECT relation.relname,con.conname,con.contype::text AS contype,con.conindid,pg_get_constraintdef(con.oid) "
                    "FROM pg_constraint con JOIN pg_class relation ON relation.oid=con.conrelid "
                    "WHERE relation.relname IN ('agent_session_contents','session_search_sources',"
                    "'session_search_chunks') ORDER BY relation.relname,con.conname"
                )
            )
        ).all()


async def test_selected_indexes_upgrade_downgrade_and_preserve_constraints(
    selected_database,
):
    database, specifications = selected_database
    before = await _constraints(database)
    await (await database.cli("upgrade", "128")).finish()
    await _assert_selected(database, specifications)
    assert await _constraints(database) == before
    await (await database.cli("downgrade", "127")).finish()
    assert await database.version() == "127"
    for spec in specifications:
        assert await _index_catalog(database, spec.name) is None
    assert await _constraints(database) == before
    await (await database.cli("upgrade", "128")).finish()
    await _assert_selected(database, specifications)


async def test_valid_indexes_survive_process_loss_before_revision_stamp(
    selected_database,
):
    database, specifications = selected_database
    interrupted = await database.cli("upgrade", "128", before_stamp=True)
    await interrupted.finish(expected=91)
    assert await database.version() == "127"
    before = await _assert_selected(database, specifications)
    await (await database.cli("upgrade", "128")).finish()
    after = await _assert_selected(database, specifications)
    assert {name: row["oid"] for name, row in after.items()} == {
        name: row["oid"] for name, row in before.items()
    }, "Usable indexes must be reused after DDL committed but version stamping did not"


async def test_interrupted_downgrade_accepts_its_already_removed_indexes(
    selected_database,
):
    database, specifications = selected_database
    await (await database.cli("upgrade", "128")).finish()
    await _assert_selected(database, specifications)
    interrupted = await database.cli("downgrade", "127", before_stamp=True)
    await interrupted.finish(expected=91)
    assert await database.version() == "128"
    for spec in specifications:
        assert await _index_catalog(database, spec.name) is None
    await (await database.cli("downgrade", "127")).finish()
    assert await database.version() == "127"


async def test_cancelled_concurrent_build_is_repaired_before_stamping(
    selected_database,
):
    database, specifications = selected_database
    before = await _constraints(database)
    async with database.engine.connect() as writer:
        transaction = await writer.begin()
        for table in sorted({spec.table for spec in specifications}):
            await writer.execute(
                text(f"LOCK TABLE public.{_identifier(table)} IN ROW EXCLUSIVE MODE")
            )
        command = await database.cli("upgrade", "128")

        async def waiting_builder():
            async with database.engine.connect() as observer:
                rows = (
                    await observer.execute(
                        text(
                            "SELECT progress.pid,index_relation.relname FROM pg_stat_progress_create_index progress "
                            "JOIN pg_class index_relation ON index_relation.oid=progress.index_relid "
                            "WHERE progress.datname=current_database() "
                            "AND progress.phase='waiting for writers before build'"
                        )
                    )
                ).all()
                owned_pids = {record["pid"] for record in _records(command.trace)}
                return next(
                    (
                        row
                        for row in rows
                        if row.pid in owned_pids
                        and row.relname in {spec.name for spec in specifications}
                    ),
                    None,
                )

        try:
            pending = await _eventually(
                waiting_builder, "own concurrent build to wait for fixture writer"
            )
            async with database.engine.connect() as observer:
                assert await observer.scalar(
                    text("SELECT pg_cancel_backend(:pid)"), {"pid": pending.pid}
                )
            async with asyncio.timeout(30):
                assert await command.process.wait() != 0
        finally:
            await transaction.rollback()
    invalid = await _index_catalog(database, pending.relname)
    assert invalid is not None and not invalid["indisvalid"]
    assert await database.version() == "127"
    await (await database.cli("upgrade", "128")).finish()
    await _assert_selected(database, specifications)
    assert await _constraints(database) == before


@pytest.mark.parametrize(
    "collision_kind", ["table", "different_index", "constraint_index"]
)
async def test_name_collision_is_preserved_and_never_stamped(
    selected_database, collision_kind
):
    database, specifications = selected_database
    spec = specifications[0]
    async with database.engine.begin() as connection:
        if collision_kind == "table":
            await connection.execute(
                text(f"CREATE TABLE public.{_identifier(spec.name)} (kept integer)")
            )
            await connection.execute(
                text(f"INSERT INTO public.{_identifier(spec.name)} VALUES (73)")
            )
        elif collision_kind == "different_index":
            await connection.execute(
                text(
                    f"CREATE INDEX {_identifier(spec.name)} ON public.{_identifier(spec.table)} (id)"
                )
            )
        else:
            await connection.execute(
                text(
                    f"ALTER TABLE public.{_identifier(spec.table)} "
                    f"ADD CONSTRAINT {_identifier(spec.name)} UNIQUE(id)"
                )
            )
    before = await _constraints(database)
    collision = await _index_catalog(database, spec.name)
    command = await database.cli("upgrade", "128")
    async with asyncio.timeout(120):
        assert await command.process.wait() != 0
    assert await database.version() == "127"
    assert await _index_catalog(database, spec.name) == collision
    assert await _constraints(database) == before
    async with database.engine.begin() as connection:
        if collision_kind == "table":
            assert (
                await connection.scalar(
                    text(f"SELECT kept FROM public.{_identifier(spec.name)}")
                )
                == 73
            )
            await connection.execute(
                text(f"DROP TABLE public.{_identifier(spec.name)}")
            )
        elif collision_kind == "different_index":
            await connection.execute(
                text(f"DROP INDEX public.{_identifier(spec.name)}")
            )
        else:
            await connection.execute(
                text(
                    f"ALTER TABLE public.{_identifier(spec.table)} DROP CONSTRAINT {_identifier(spec.name)}"
                )
            )
    await (await database.cli("upgrade", "128")).finish()
    await _assert_selected(database, specifications)
