# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import Query


class PaginationParams:
    def __init__(
        self,
        page: int = Query(default=1, ge=1),
        per_page: int = Query(default=20, ge=1, le=100),
    ):
        self.page = page
        self.per_page = per_page
        self.offset = (page - 1) * per_page
