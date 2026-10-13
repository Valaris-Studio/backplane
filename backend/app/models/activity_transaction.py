# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy.ext.compiler import compiles
from sqlalchemy.sql.functions import FunctionElement
from sqlalchemy.types import UserDefinedType


class TransactionID(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw):
        return "xid8"


class TransactionSnapshot(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw):
        return "pg_snapshot"


class CurrentTransaction(FunctionElement):
    inherit_cache = True


@compiles(CurrentTransaction, "postgresql")
def _postgres_transaction(element, compiler, **kw):
    return "pg_current_xact_id()"


@compiles(CurrentTransaction)
def _non_postgres_transaction(element, compiler, **kw):
    return "NULL"
