# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
from pathlib import Path

from app.routers.local_storage import MAX_UPLOAD_BYTES


def test_production_proxy_accepts_the_local_storage_upload_limit():
    config = (Path(__file__).resolve().parents[2] / "frontend/nginx.conf").read_text()
    api_location = config.split("location /api/ {", 1)[1].split("\n    }", 1)[0]
    limit = re.search(r"client_max_body_size\s+(\d+)([mk]?);", api_location)
    assert limit, "The API proxy must explicitly allow local-storage uploads"
    multiplier = {"": 1, "k": 1024, "m": 1024 * 1024}[limit[2]]
    assert int(limit[1]) * multiplier == MAX_UPLOAD_BYTES
