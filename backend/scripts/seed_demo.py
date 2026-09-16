# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""CLI wrapper for the demo seed — `make seed-demo`.

Usage (from backend/):
    python -m scripts.seed_demo [--force] [--email you@example.com]

Needs only a reachable database: no Go toolchain, no LLM key, no network.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

# app.database builds its engine at import time with echo=settings.is_development,
# and echo attaches a handler that no later level change can quiet. This is a
# one-shot CLI whose useful output is two lines, so opt out at the source before
# the import happens.
os.environ.setdefault("ENV", "production")


async def _run(force: bool, email: str | None) -> int:
    from app.database import async_session
    from app.services.seed_demo import DEMO_SLUG, SeedRefused, seed_demo

    async with async_session() as session:
        try:
            result = await seed_demo(session, force=force, member_email=email)
        except SeedRefused as exc:
            print(f"✗ {exc.detail}", file=sys.stderr)
            return 1
        await session.commit()

    if result.created:
        print(f"✓ Seeded the '{DEMO_SLUG}' workspace with a sample board.")
        print("  Open the app and pick it from the workspace list.")
    else:
        print(f"✓ The '{DEMO_SLUG}' workspace already exists — nothing to do.")
    if email:
        print(f"  {email} has owner access to it.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed a demo workspace.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Seed even though this instance already holds other workspaces.",
    )
    parser.add_argument(
        "--email",
        help="Grant this account owner access to the demo workspace "
        "(use the email you sign in with).",
    )
    args = parser.parse_args()
    return asyncio.run(_run(args.force, args.email))


if __name__ == "__main__":
    raise SystemExit(main())
