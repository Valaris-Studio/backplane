#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build (and optionally publish) a Backplane Companion desktop release: the
# notarized universal DMG, the signed in-app update archive (.app.tar.gz +
# .sig) and the channel's latest.json.
#
# Usage:
#   scripts/release-companion-desktop.sh VERSION [--channel stable|beta] [--notes TEXT] [--publish] [--skip-notarize]
#
#   VERSION          release version without the leading v (e.g. 0.2.0);
#                    stamped into the app and the companion, and used as
#                    the GCS folder v$VERSION.
#   --channel        update channel whose latest.json is replaced (default: stable).
#   --publish        upload to gs://backplane-artifacts/companion-desktop/v$VERSION/
#                    (public bucket), then the channel's latest.json last, with
#                    Cache-Control: no-cache, max-age=0. Requires
#                    BACKPLANE_RELEASE_PROJECT, the GCP project that owns the
#                    bucket; the active gcloud project must match it.
#                    Without it this is a dry run: build, write latest.json and
#                    print the planned uploads. Never re-uploads a published version.
#   --skip-notarize  dry runs only: Developer ID sign without notarizing.
#
# Needs DEVELOPER_ID_APP (+ AC_API_KEY_ID, AC_API_ISSUER, AC_API_KEY_P8 unless
# --skip-notarize) and the updater key in ~/.backplane-signing/. Artifacts land
# in companion/dist/desktop-release/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 "$REPO_ROOT/companion/scripts/release_desktop.py" "$@"
