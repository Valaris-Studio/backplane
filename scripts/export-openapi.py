#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Export the FastAPI OpenAPI schema to docs/api/openapi.json.

Run with the backend virtualenv active:

    cd backend && source .venv/bin/activate && cd ..
    python scripts/export-openapi.py
"""

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "docs/api/openapi.json")
    args = parser.parse_args()

    # Settings reads `.env` relative to CWD; only backend/.env matches its
    # schema (the repo-root .env carries runner credentials it must not load).
    os.chdir(REPO_ROOT / "backend")
    from app.main import app

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(app.openapi(), indent=2) + "\n")
    print(f"{args.out.relative_to(REPO_ROOT)}: {len(app.openapi()['paths'])} paths")


if __name__ == "__main__":
    main()
