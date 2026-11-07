# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Expose the actual transaction xid in a leader-only search projection."""

from alembic import op
import sqlalchemy as sa

revision = "130"
down_revision = "129"
branch_labels = None
depends_on = None

NAME = "session_search_leader_xid_if_assigned"
BODY = "\nBEGIN\n    RETURN pg_catalog.pg_current_xact_id_if_assigned();\nEND;\n"
CREATE = (
    f"CREATE FUNCTION public.{NAME}() RETURNS pg_catalog.xid8 "
    "LANGUAGE plpgsql STABLE PARALLEL RESTRICTED SECURITY INVOKER "
    f"AS $body${BODY}$body$"
)

CATALOG = sa.text("""
    SELECT p.oid, p.prokind::pg_catalog.text AS kind, p.pronargs, p.pronargdefaults,
           p.proargtypes::pg_catalog.text AS argument_types, p.proallargtypes,
           p.proargmodes, p.proargnames, p.proargdefaults::pg_catalog.text,
           p.provariadic, p.proretset,
           p.prorettype = 'pg_catalog.xid8'::pg_catalog.regtype AS returns_xid8,
           l.lanname AS language, p.provolatile::pg_catalog.text AS volatility,
           p.proparallel::pg_catalog.text AS parallel, p.prosecdef, p.proisstrict,
           p.proleakproof, p.proconfig, p.prosrc, p.probin,
           p.prosupport::pg_catalog.oid AS support_oid, p.prosqlbody::pg_catalog.text,
           p.procost, p.prorows,
           pg_catalog.pg_get_userbyid(p.proowner) AS owner, current_user AS migration_role,
           EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                   WHERE d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.objid = p.oid
                     AND d.deptype = 'e') AS extension_member
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname = :name
    ORDER BY p.oid
""")


def _exact_function(connection):
    rows = connection.execute(CATALOG, {"name": NAME}).mappings().all()
    if not rows:
        return None
    # Reserve this internal name, including default-argument overloads. Never
    # replace an unknown body or silently adopt a different owner's function.
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
    if (
        len(rows) != 1
        or rows[0]["owner"] != rows[0]["migration_role"]
        or any(rows[0][field] != value for field, value in expected.items())
    ):
        raise RuntimeError(
            f"Migration 130 refuses conflicting function public.{NAME}; "
            "its signature, body, flags or ownership do not match"
        )
    return rows[0]


def _bounded_connection():
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        return None
    if op.get_context().as_sql:
        raise RuntimeError(
            "Migration 130 requires online PostgreSQL catalog validation"
        )
    # Function DDL and the revision stamp share the caller's transaction. These
    # limits disappear on commit/rollback and never widen a tighter setting.
    for name, maximum in (("statement_timeout", 30000), ("lock_timeout", 5000)):
        connection.execute(
            sa.text("""
                SELECT pg_catalog.set_config(
                    :name,
                    LEAST(COALESCE(NULLIF(setting::bigint, 0), :maximum), :maximum)::pg_catalog.text,
                    true
                )
                FROM pg_catalog.pg_settings WHERE name = :name
            """),
            {"name": name, "maximum": maximum},
        )
    return connection


def upgrade():
    connection = _bounded_connection()
    if connection is None:
        return
    if _exact_function(connection) is None:
        op.execute(CREATE)
        if _exact_function(connection) is None:
            raise RuntimeError("Migration 130 did not create its exact leader getter")


def downgrade():
    connection = _bounded_connection()
    if connection is None:
        return
    if _exact_function(connection) is not None:
        op.execute(f"DROP FUNCTION public.{NAME}() RESTRICT")
