# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Annotated string types that mirror the models' bounded VARCHAR widths.

A `String(N)` column with no Pydantic `max_length` behind it is a latent 500:
Pydantic accepts the value, Postgres raises `StringDataRightTruncation`, and it
escapes the router unhandled. Declaring the width once here — rather than
repeating `Field(max_length=255)` at every write schema — is what keeps the
mirror honest; `tests/schemas/test_bounded_string_parity.py` reads both sides
and fails if a column is widened without its schema following.

Naming is by WIDTH, not by field, because the same width backs unrelated
columns (`workspace.name`, `board.name`, `channel.name` are all 255). A field
whose limit is agent-facing and worth naming keeps a semantic constant next to
its schema — see `TITLE_MAX_LENGTH` in `app/schemas/kanban/card.py`.
"""

from typing import Annotated

from pydantic import Field


Str7 = Annotated[str, Field(max_length=7)]
Str100 = Annotated[str, Field(max_length=100)]
Str255 = Annotated[str, Field(max_length=255)]
Str500 = Annotated[str, Field(max_length=500)]
Str1024 = Annotated[str, Field(max_length=1024)]
Str2048 = Annotated[str, Field(max_length=2048)]
