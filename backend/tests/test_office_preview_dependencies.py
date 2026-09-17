# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("lock_path", ["pnpm-lock.yaml", "frontend/pnpm-lock.yaml"])
def test_office_parsers_do_not_resolve_known_vulnerable_releases(lock_path):
    # Both native workspace installs and standalone Docker installs parse uploads.
    packages = yaml.safe_load((ROOT / lock_path).read_text())["packages"]
    xml_versions = [key.split("@")[-1] for key in packages if key.startswith("@xmldom/xmldom@")]
    assert xml_versions, "Mammoth's XML parser must remain covered by this gate"
    assert all(tuple(map(int, version.split("."))) >= (0, 8, 15) for version in xml_versions), (
        "xmldom <0.8.15 has known XML parser CPU/memory exhaustion issues"
    )
    spreadsheet_keys = [key for key in packages if key.startswith("xlsx@")]
    assert spreadsheet_keys, "Spreadsheet preview's parser must remain covered by this gate"
    for key in spreadsheet_keys:
        version = re.search(r"(?:xlsx@|xlsx-)(\d+\.\d+\.\d+)", key)
        assert version and tuple(map(int, version[1].split("."))) >= (0, 20, 2), (
            "SheetJS <0.20.2 includes CVE-2023-30533/CVE-2024-22363"
        )
        resolution = packages[key]["resolution"]
        assert resolution.get("integrity"), "Pin the official parser bytes as well as the URL"
