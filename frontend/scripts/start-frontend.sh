#!/bin/sh
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
# The substitution below pastes the secret raw into nginx.conf: a quote breaks the config and
# a $ is read as an nginx variable, so only token-safe characters get through.
case "${EDGE_PROXY_SECRET:-}" in
    *[!A-Za-z0-9_-]*)
        echo "EDGE_PROXY_SECRET may only contain A-Z a-z 0-9 _ - ; generate one with: openssl rand -hex 32" >&2
        exit 1
        ;;
esac
# Copy retired assets only into a real volume: without one (Cloud Run) the copy lands in the
# in-memory filesystem and OOM-kills the container; nginx serves the image's history directly.
# The image never creates this directory, so finding it means something was mounted there.
ASSET_VOLUME=/var/lib/backplane/frontend
retain_to_volume=false
case "$(printf '%s' "${RETAIN_ASSETS_TO_VOLUME:-}" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) retain_to_volume=true ;;
    false|0|no) ;;
    '')
        if [ -d "$ASSET_VOLUME" ]; then
            volume_fs=$(awk -v mount="$ASSET_VOLUME" '$2 == mount { fs = $3 } END { print fs }' /proc/mounts 2>/dev/null || true)
            if [ "$volume_fs" = "tmpfs" ]; then
                echo "$ASSET_VOLUME is tmpfs (memory); not retaining assets there. Set RETAIN_ASSETS_TO_VOLUME=true to force." >&2
            else
                retain_to_volume=true
            fi
        fi
        ;;
    *)
        echo "RETAIN_ASSETS_TO_VOLUME must be true/1/yes or false/0/no (case-insensitive), or unset to auto-detect a mounted volume" >&2
        exit 1
        ;;
esac
if [ "$retain_to_volume" = true ]; then
    python3 /usr/local/bin/retain-assets.py /usr/share/nginx/html/.asset-history "$ASSET_VOLUME"
fi
envsubst '${BACKEND_URL} ${EDGE_PROXY_SECRET}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
