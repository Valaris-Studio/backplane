# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
from functools import lru_cache
from pathlib import Path


class ProductDocumentationRepository:
    @staticmethod
    @lru_cache(maxsize=1)
    def read_catalog() -> dict:
        path = Path(__file__).resolve().parents[1] / "data/product-documentation.json"
        return json.loads(path.read_text(encoding="utf-8"))
