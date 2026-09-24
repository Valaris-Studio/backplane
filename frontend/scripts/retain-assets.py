#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

MANIFEST = '.asset-retention.json'
DEFAULT_GRACE_SECONDS = 7 * 24 * 60 * 60
ASSET_NAME = re.compile(r'[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+')


def inventory(root):
    manifest = root / MANIFEST
    if manifest.exists():
        state = json.loads(manifest.read_text())
    else:
        state = {'active': [p.name for p in (root / 'assets').glob('*')], 'expires': {}}
    active, expires = state['active'], state['expires']
    if not isinstance(active, list) or not isinstance(expires, dict):
        raise ValueError('Invalid asset manifest')
    for name in [*active, *expires]:
        if not isinstance(name, str) or not ASSET_NAME.fullmatch(name):
            raise ValueError('Invalid hashed asset name')
        path = root / 'assets' / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Invalid asset file: {name}')
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in expires.values()):
        raise ValueError('Invalid asset expiry')
    return set(active), expires


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def retain_assets(source, destination, *, now, grace):
    if not math.isfinite(grace) or grace <= 0:
        raise ValueError('Asset grace period must be positive')
    destination.mkdir(parents=True, exist_ok=True)
    # Compose replicas may start together. Readers see only complete files.
    with (destination / '.asset-retention.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current, seeded_expiry = inventory(source)
        previous, previous_expiry = inventory(destination)
        expires = dict(previous_expiry)
        for name, expiry in seeded_expiry.items():
            expires[name] = max(expires.get(name, expiry), expiry)
        for name in previous - current:
            expires[name] = now + grace
        expires = {name: expiry for name, expiry in expires.items() if name not in current and expiry > now}
        keep = current | expires.keys()
        assets = destination / 'assets'
        assets.mkdir(exist_ok=True)
        # Validate every collision before writing anything: hashed URLs are immutable.
        for name in keep:
            candidate = source / 'assets' / name
            existing = assets / name
            if candidate.exists() and existing.exists() and candidate.read_bytes() != existing.read_bytes():
                raise ValueError(f'Hashed asset collision: {name}')
        for name in keep:
            candidate = source / 'assets' / name
            if candidate.is_file() and not (assets / name).exists():
                atomic_write(assets / name, candidate.read_bytes())
        atomic_write(destination / MANIFEST, json.dumps({'active': sorted(current), 'expires': expires}, sort_keys=True).encode())
        for path in assets.iterdir():
            if path.name not in keep:
                path.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--previous', type=Path)
    parser.add_argument('--grace-seconds', type=int, default=DEFAULT_GRACE_SECONDS)
    args = parser.parse_args()
    now = time.time()
    if args.previous:
        previous = args.previous / '.asset-history'
        retain_assets(previous if previous.is_dir() else args.previous, args.destination, now=now, grace=args.grace_seconds)
    retain_assets(args.source, args.destination, now=now, grace=args.grace_seconds)
