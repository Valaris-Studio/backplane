# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timezone


def as_utc(value: datetime) -> datetime:
    # SQLite hands timestamps back naive; they were written as UTC.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
