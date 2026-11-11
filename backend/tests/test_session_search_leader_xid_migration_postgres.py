# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Native contracts for the exact leader getter and transactional migration 130."""

import asyncio
import json

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import DBAPIError

from tests.test_session_search_index_migration_postgres import (
    SELECTED_INDEXES,
    _constraints,
    _index_catalog,
    _records,
    migration_database,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(150)]
NAME = "session_search_leader_xid_if_assigned"
BODY = "\nBEGIN\n    RETURN pg_catalog.pg_current_xact_id_if_assigned();\nEND;\n"
CREATE = (
    f"CREATE FUNCTION public.{NAME}() RETURNS pg_catalog.xid8 "
    "LANGUAGE plpgsql STABLE PARALLEL RESTRICTED SECURITY INVOKER "
    f"AS $body${BODY}$body$"
)
CATALOG = text("""
    SELECT p.oid, p.prokind::text AS kind, p.pronargs, p.pronargdefaults,
           p.proargtypes::text AS argument_types, p.proallargtypes,
           p.proargmodes, p.proargnames, p.proargdefaults::text,
           p.provariadic, p.proretset,
           p.prorettype = 'pg_catalog.xid8'::regtype AS returns_xid8,
           l.lanname AS language, p.provolatile::text AS volatility,
           p.proparallel::text AS parallel, p.prosecdef, p.proisstrict,
           p.proleakproof, p.proconfig, p.prosrc, p.probin,
           p.prosupport::oid AS support_oid, p.prosqlbody::text,
           p.procost, p.prorows, p.proacl::text AS acl,
           pg_get_userbyid(p.proowner) AS owner, current_user AS migration_role,
           obj_description(p.oid, 'pg_proc') AS comment,
           EXISTS (SELECT 1 FROM pg_depend d
                   WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                     AND d.deptype = 'e') AS extension_member
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname = :name
    ORDER BY p.oid
""")


@pytest.fixture
async def getter_database(migration_database):  # noqa: F811
    # The shared runner traverses the real 127, 128 and 129, without stamping.
    await (await migration_database.cli("upgrade", "129")).finish()
    assert await migration_database.version() == "129"
    return migration_database


async def catalog(database):
    async with database.engine.connect() as connection:
        rows = await connection.execute(CATALOG, {"name": NAME})
        return [dict(row) for row in rows.mappings()]


async def core_catalog(database):
    async with database.engine.connect() as connection:
        return await connection.scalar(
            text("""
            SELECT to_jsonb(p)::text FROM pg_proc p
            WHERE p.oid = 'pg_catalog.pg_current_xact_id_if_assigned()'::regprocedure
        """)
        )


async def search_schema(database):
    names = [spec.name for spec in SELECTED_INDEXES] + [
        "uq_agent_session_contents_id_session",
        "uq_session_search_sources_id_session",
    ]
    return (
        {name: await _index_catalog(database, name) for name in names},
        await _constraints(database),
    )


async def assert_getter(database):
    rows = await catalog(database)
    assert len(rows) == 1, rows
    row = rows[0]
    expected = {
        "kind": "f",
        "pronargs": 0,
        "pronargdefaults": 0,
        "argument_types": "",
        "proallargtypes": None,
        "proargmodes": None,
        "proargnames": None,
        "proargdefaults": None,
        "provariadic": 0,
        "proretset": False,
        "returns_xid8": True,
        "language": "plpgsql",
        "volatility": "s",
        "parallel": "r",
        "prosecdef": False,
        "proisstrict": False,
        "proleakproof": False,
        "proconfig": None,
        "prosrc": BODY,
        "probin": None,
        "support_oid": 0,
        "prosqlbody": None,
        "procost": 100,
        "prorows": 0,
        "extension_member": False,
    }
    for field, value in expected.items():
        assert row[field] == value, (field, row)
    assert row["owner"] == row["migration_role"]
    return row


async def assert_rejected(command):
    async with asyncio.timeout(120):
        assert await command.process.wait() != 0, command.log.read_text()
    assert "Migration 130 refuses conflicting" in command.log.read_text()


async def test_clean_upgrade_calls_exact_core_and_preserves_search_schema(
    getter_database,
):
    database = getter_database
    core_before = await core_catalog(database)
    assert json.loads(core_before)["proparallel"] == "u"
    assert json.loads(core_before)["provolatile"] == "s"
    schema_before = await search_schema(database)
    assert await catalog(database) == []
    command = await database.cli("upgrade", "head")
    await command.finish()
    # On the current 129 baseline this is a real UndefinedFunctionError (42883),
    # rather than an Alembic error about a nonexistent revision name.
    async with database.engine.connect() as connection:
        row = (
            await connection.execute(
                text(
                    f"SELECT public.{NAME}()::text, "
                    "pg_catalog.pg_current_xact_id_if_assigned()::text"
                )
            )
        ).one()
        assert tuple(row) == (None, None)
        await connection.execute(text("CREATE TEMP TABLE getter_probe (value integer)"))
        first = (
            await connection.execute(
                text(
                    f"SELECT public.{NAME}()::text, "
                    "pg_catalog.pg_current_xact_id_if_assigned()::text"
                )
            )
        ).one()
        assert first[0] is not None and first[0] == first[1]
        await connection.execute(text("INSERT INTO getter_probe VALUES (1)"))
        assert (
            await connection.scalar(text(f"SELECT public.{NAME}()::text")) == first[0]
        )
    assert await database.version() == "130"
    await assert_getter(database)
    assert await core_catalog(database) == core_before
    assert await search_schema(database) == schema_before
    creates = [
        r["sql"]
        for r in _records(command.trace)
        if r["sql"].lstrip().upper().startswith("CREATE FUNCTION")
    ]
    assert len(creates) == 1
    assert creates[0].strip().rstrip(";") == CREATE
    assert not any(
        "CREATE OR REPLACE" in r["sql"].upper() for r in _records(command.trace)
    )


async def test_default_acl_and_exact_existing_function_are_preserved(getter_database):
    database = getter_database
    async with database.engine.begin() as connection:
        await connection.execute(
            text("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC")
        )
    await (await database.cli("upgrade", "head")).finish()
    installed = await assert_getter(database)
    async with database.engine.connect() as connection:
        assert not await connection.scalar(
            text("""
            SELECT EXISTS (
                SELECT 1 FROM pg_proc p,
                     LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE p.oid = CAST(:oid AS oid)
                  AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
            )
        """),
            {"oid": installed["oid"]},
        )
    await (await database.cli("downgrade", "129")).finish()
    async with database.engine.begin() as connection:
        await connection.execute(text(CREATE))
        await connection.execute(
            text(f"COMMENT ON FUNCTION public.{NAME}() IS 'owned retry evidence'")
        )
        await connection.execute(
            text(f"CREATE VIEW getter_dependent AS SELECT public.{NAME}() AS xid")
        )
    existing = await catalog(database)
    command = await database.cli("upgrade", "head")
    await command.finish()
    assert await database.version() == "130"
    assert await catalog(database) == existing
    assert not any(
        r["sql"].lstrip().upper().startswith("CREATE FUNCTION")
        for r in _records(command.trace)
    )
    async with database.engine.connect() as connection:
        assert await connection.scalar(
            text("SELECT to_regclass('public.getter_dependent')")
        )


@pytest.mark.parametrize(
    "collision",
    [
        "body",
        "sql_language",
        "volatile",
        "parallel_safe",
        "security_definer",
        "search_path",
        "strict",
        "return_type",
        "overload",
    ],
)
async def test_conflicting_function_is_preserved(getter_database, collision):
    database = getter_database
    statement = CREATE
    if collision == "body":
        statement = statement.replace(
            "RETURN pg_catalog.pg_current_xact_id_if_assigned();", "RETURN NULL;"
        )
    elif collision == "sql_language":
        statement = statement.replace("LANGUAGE plpgsql", "LANGUAGE sql").replace(
            BODY, "SELECT pg_catalog.pg_current_xact_id_if_assigned();"
        )
    elif collision == "volatile":
        statement = statement.replace(" STABLE ", " VOLATILE ")
    elif collision == "parallel_safe":
        statement = statement.replace("PARALLEL RESTRICTED", "PARALLEL SAFE")
    elif collision == "security_definer":
        statement = statement.replace("SECURITY INVOKER", "SECURITY DEFINER")
    elif collision == "search_path":
        statement = statement.replace(
            "SECURITY INVOKER", "SECURITY INVOKER SET search_path = public"
        )
    elif collision == "strict":
        statement = statement.replace("SECURITY INVOKER", "SECURITY INVOKER STRICT")
    elif collision == "return_type":
        statement = statement.replace("RETURNS pg_catalog.xid8", "RETURNS text")
    async with database.engine.begin() as connection:
        # asyncpg accepts one DDL statement per execute.
        if collision == "overload":
            await connection.execute(text(CREATE))
            await connection.execute(
                text(CREATE.replace(f"{NAME}()", f"{NAME}(unused integer DEFAULT 0)"))
            )
        else:
            await connection.execute(text(statement))
    before = await catalog(database)
    core_before = await core_catalog(database)
    await assert_rejected(await database.cli("upgrade", "head"))
    assert await database.version() == "129"
    assert await catalog(database) == before
    assert await core_catalog(database) == core_before


async def test_function_owned_by_another_role_is_preserved(getter_database):
    database = getter_database
    async with database.engine.begin() as connection:
        await connection.execute(text(CREATE))
        # This built-in role owns the fresh database's public schema. Its OID
        # differs from the migration login, without creating a cluster role.
        await connection.execute(
            text(f"ALTER FUNCTION public.{NAME}() OWNER TO pg_database_owner")
        )
    before = await catalog(database)
    assert before[0]["owner"] == "pg_database_owner"
    assert before[0]["owner"] != before[0]["migration_role"]
    await assert_rejected(await database.cli("upgrade", "head"))
    assert await catalog(database) == before
    assert await database.version() == "129"


async def test_process_loss_before_stamp_rolls_back_function_and_version(
    getter_database,
):
    database = getter_database
    command = await database.cli("upgrade", "head", before_stamp=True)
    await command.finish(expected=91)
    assert await database.version() == "129"
    assert await catalog(database) == []
    await (await database.cli("upgrade", "head")).finish()
    await assert_getter(database)
    assert await database.version() == "130"


async def test_restrict_downgrade_preserves_dependent_then_rolls_back_drop_on_loss(
    getter_database,
):
    database = getter_database
    await (await database.cli("upgrade", "head")).finish()
    function = await assert_getter(database)
    schema = await search_schema(database)
    async with database.engine.begin() as connection:
        await connection.execute(
            text(f"CREATE VIEW getter_dependent AS SELECT public.{NAME}() AS xid")
        )
    command = await database.cli("downgrade", "129")
    async with asyncio.timeout(120):
        assert await command.process.wait() != 0
    assert "DependentObjectsStillExistError" in command.log.read_text()
    assert await database.version() == "130"
    assert await assert_getter(database) == function
    async with database.engine.begin() as connection:
        assert await connection.scalar(
            text("SELECT to_regclass('public.getter_dependent')")
        )
        await connection.execute(text("DROP VIEW public.getter_dependent"))
    interrupted = await database.cli("downgrade", "129", before_stamp=True)
    await interrupted.finish(expected=91)
    assert await database.version() == "130"
    assert await assert_getter(database) == function
    await (await database.cli("downgrade", "129")).finish()
    assert await database.version() == "129" and await catalog(database) == []
    assert await search_schema(database) == schema


async def test_downgrade_preserves_changed_function(getter_database):
    database = getter_database
    await (await database.cli("upgrade", "head")).finish()
    await assert_getter(database)
    async with database.engine.begin() as connection:
        await connection.execute(
            text(f"ALTER FUNCTION public.{NAME}() PARALLEL UNSAFE")
        )
    changed = await catalog(database)
    await assert_rejected(await database.cli("downgrade", "129"))
    assert await catalog(database) == changed
    assert await database.version() == "130"


async def test_caller_search_path_does_not_redirect_getter(getter_database):
    database = getter_database
    await (await database.cli("upgrade", "head")).finish()
    await assert_getter(database)
    async with database.engine.begin() as connection:
        await connection.execute(text("CREATE SCHEMA getter_shadow"))
        await connection.execute(
            text("""
            CREATE FUNCTION getter_shadow.pg_current_xact_id_if_assigned()
            RETURNS pg_catalog.xid8 LANGUAGE sql AS 'SELECT NULL::pg_catalog.xid8'
        """)
        )
        await connection.execute(
            text("SET LOCAL search_path = getter_shadow, public, pg_catalog")
        )
        row = (
            await connection.execute(
                text(
                    f"SELECT public.{NAME}()::text, "
                    "pg_catalog.pg_current_xact_id_if_assigned()::text, "
                    "pg_current_xact_id_if_assigned()::text"
                )
            )
        ).one()
        assert row[0] == row[1] and row[0] is not None
        assert (
            row[2] is None
        ), "The negative-control search path must actually resolve the fake getter"


async def test_invoker_execute_permissions_and_own_backend_xid(getter_database):
    database = getter_database
    receipt = {"state": "STARTED", "privilege_sql": [], "denials": [], "xid_calls": []}

    def capture(_connection, _cursor, sql, _parameters, _context, _many):
        if sql.lstrip().upper().startswith(("GRANT ", "REVOKE ", "SET LOCAL ROLE ")):
            receipt["privilege_sql"].append(sql)

    async def denied(connection, statement, label):
        with pytest.raises(DBAPIError) as error:
            async with connection.begin_nested():
                await connection.execute(text(statement))
        state = error.value.orig.sqlstate
        receipt["denials"].append({"label": label, "sqlstate": state})
        assert state == "42501", label

    async def current_xid(connection, label):
        before = await connection.scalar(
            text("SELECT pg_catalog.pg_current_xact_id_if_assigned()::text")
        )
        actual = await connection.scalar(text(f"SELECT public.{NAME}()::text"))
        after = await connection.scalar(
            text("SELECT pg_catalog.pg_current_xact_id_if_assigned()::text")
        )
        receipt["xid_calls"].append(
            {"label": label, "before": before, "actual": actual, "after": after}
        )
        assert before == actual == after, label
        return actual

    async def monitor_identity(connection):
        role = dict(
            (
                await connection.execute(
                    text("""
            SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole,
                   rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
            FROM pg_catalog.pg_roles WHERE rolname = 'pg_monitor'
        """)
                )
            )
            .mappings()
            .one()
        )
        memberships = [
            list(row)
            for row in (
                await connection.execute(
                    text("""
            SELECT roleid, member, grantor, admin_option, inherit_option, set_option
            FROM pg_catalog.pg_auth_members
            WHERE roleid = :oid OR member = :oid ORDER BY roleid, member, grantor
        """),
                    {"oid": role["oid"]},
                )
            ).all()
        ]
        return {"role": role, "memberships": memberships}

    async def restored(connection, expected, label):
        actual = await connection.scalar(text("SELECT current_user"))
        receipt.setdefault("restored_roles", []).append(
            {"label": label, "expected": expected, "actual": actual}
        )
        assert actual == expected, label
        await connection.rollback()

    event.listen(database.engine.sync_engine, "before_cursor_execute", capture)
    try:
        receipt["phase"] = "install-and-capability-check"
        await (await database.cli("upgrade", "head")).finish()
        installed = await assert_getter(database)
        core_before = await core_catalog(database)
        async with database.engine.begin() as connection:
            monitor_before = await monitor_identity(connection)
            role = monitor_before["role"]
            assert role["rolinherit"]
            assert not any(
                role[name]
                for name in (
                    "rolsuper",
                    "rolcreaterole",
                    "rolcreatedb",
                    "rolcanlogin",
                    "rolreplication",
                    "rolbypassrls",
                )
            ), role
            assert not await connection.scalar(
                text("""
                SELECT pg_catalog.pg_has_role('pg_monitor', 'pg_read_all_data', 'USAGE')
                    OR pg_catalog.pg_has_role('pg_monitor', 'pg_write_all_data', 'USAGE')
                    OR pg_catalog.pg_has_role('pg_monitor', current_user, 'USAGE')
            """)
            )
            await connection.execute(
                text("CREATE TABLE public.getter_invoker_private (value integer)")
            )
            await connection.execute(
                text("CREATE TABLE public.getter_invoker_writes (value integer)")
            )
            await connection.execute(
                text("INSERT INTO public.getter_invoker_private VALUES (2718)")
            )
            await connection.execute(
                text(f"REVOKE ALL ON FUNCTION public.{NAME}() FROM PUBLIC, pg_monitor")
            )
            await connection.execute(text("GRANT USAGE ON SCHEMA public TO pg_monitor"))
            await connection.execute(
                text(
                    "REVOKE ALL ON TABLE public.getter_invoker_private, public.getter_invoker_writes FROM PUBLIC, pg_monitor"
                )
            )
            await connection.execute(
                text("GRANT INSERT ON TABLE public.getter_invoker_writes TO pg_monitor")
            )
            assert not await connection.scalar(
                text(
                    f"SELECT pg_catalog.has_function_privilege('pg_monitor', 'public.{NAME}()', 'EXECUTE')"
                )
            )
            assert not await connection.scalar(
                text(
                    "SELECT pg_catalog.has_table_privilege('pg_monitor', 'public.getter_invoker_private', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')"
                )
            )

        async with (
            database.engine.connect() as caller,
            database.engine.connect() as other,
        ):
            caller_login = await caller.scalar(text("SELECT current_user"))
            other_login = await other.scalar(text("SELECT current_user"))
            caller_pid = await caller.scalar(text("SELECT pg_catalog.pg_backend_pid()"))
            other_pid = await other.scalar(text("SELECT pg_catalog.pg_backend_pid()"))
            assert caller_pid != other_pid
            receipt["backend_pids"] = [caller_pid, other_pid]
            await caller.rollback()
            await other.rollback()

            receipt["phase"] = "denied-before-grant"
            async with caller.begin():
                await caller.execute(text("SET LOCAL ROLE pg_monitor"))
                assert await caller.scalar(text("SELECT current_user")) == "pg_monitor"
                await denied(caller, f"SELECT public.{NAME}()", "function-before-grant")
                await denied(
                    caller,
                    "SELECT value FROM public.getter_invoker_private",
                    "private-before-function",
                )
            await restored(caller, caller_login, "after-initial-denials")

            async with other.begin():
                await other.execute(
                    text(f"GRANT EXECUTE ON FUNCTION public.{NAME}() TO pg_monitor")
                )
            receipt["phase"] = "granted-invoker-on-two-backends"
            async with caller.begin(), other.begin():
                await caller.execute(text("SET LOCAL ROLE pg_monitor"))
                await other.execute(text("SET LOCAL ROLE pg_monitor"))
                assert await caller.scalar(text("SELECT current_user")) == "pg_monitor"
                assert await other.scalar(text("SELECT current_user")) == "pg_monitor"
                assert await caller.scalar(
                    text(
                        f"SELECT pg_catalog.has_function_privilege(current_user, 'public.{NAME}()', 'EXECUTE')"
                    )
                )
                assert await current_xid(caller, "caller-before-own-write") is None
                await caller.execute(
                    text("INSERT INTO public.getter_invoker_writes VALUES (1)")
                )
                await other.execute(
                    text("INSERT INTO public.getter_invoker_writes VALUES (2)")
                )
                caller_xid = await current_xid(caller, "caller-after-own-write")
                other_xid = await current_xid(other, "other-after-own-write")
                assert caller_xid is not None and other_xid is not None
                assert caller_xid != other_xid
                await denied(
                    caller,
                    "SELECT value FROM public.getter_invoker_private",
                    "caller-private-after-function",
                )
                await denied(
                    other,
                    "SELECT value FROM public.getter_invoker_private",
                    "other-private-after-function",
                )
                assert (
                    await current_xid(caller, "caller-after-denied-read") == caller_xid
                )
                assert await current_xid(other, "other-after-denied-read") == other_xid
                assert await caller.scalar(text("SELECT current_user")) == "pg_monitor"
                assert await other.scalar(text("SELECT current_user")) == "pg_monitor"
            await restored(caller, caller_login, "after-success-caller")
            await restored(other, other_login, "after-success-other")

            async with other.begin():
                await other.execute(
                    text(f"REVOKE EXECUTE ON FUNCTION public.{NAME}() FROM pg_monitor")
                )
            receipt["phase"] = "denied-after-revoke"
            async with caller.begin():
                await caller.execute(text("SET LOCAL ROLE pg_monitor"))
                assert await caller.scalar(text("SELECT current_user")) == "pg_monitor"
                assert not await caller.scalar(
                    text(
                        f"SELECT pg_catalog.has_function_privilege(current_user, 'public.{NAME}()', 'EXECUTE')"
                    )
                )
                await denied(caller, f"SELECT public.{NAME}()", "function-after-revoke")
            await restored(caller, caller_login, "after-final-denial")
            await restored(other, other_login, "after-admin-revoke")

        final = await assert_getter(database)
        assert {key: value for key, value in final.items() if key != "acl"} == {
            key: value for key, value in installed.items() if key != "acl"
        }
        assert await core_catalog(database) == core_before
        async with database.engine.connect() as connection:
            assert await monitor_identity(connection) == monitor_before
            assert not await connection.scalar(
                text(
                    "SELECT pg_catalog.has_table_privilege('pg_monitor', 'public.getter_invoker_private', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')"
                )
            )
        receipt["phase"] = "complete"
        receipt["state"] = "PASS"
    except BaseException as error:
        receipt["state"] = "FAILED"
        receipt["error_type"] = type(error).__name__
        receipt["sqlstate"] = getattr(getattr(error, "orig", None), "sqlstate", None)
        raise
    finally:
        event.remove(database.engine.sync_engine, "before_cursor_execute", capture)
        with (database.directory / "leader-getter-invoker-privileges.json").open(
            "x"
        ) as output:
            json.dump(receipt, output, indent=2)
            output.write("\n")
