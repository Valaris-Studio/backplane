#!/bin/sh
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
python3 /usr/local/bin/retain-assets.py \
    /usr/share/nginx/html/.asset-history /var/lib/backplane/frontend
# Current files stay in the image; only retired assets use the persistent fallback.
envsubst '${BACKEND_URL}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
