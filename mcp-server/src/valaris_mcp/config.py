# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import os


API_BASE_URL = os.environ.get("VALARIS_API_URL", "http://localhost:8000")
AGENT_EMAIL = os.environ.get("VALARIS_AGENT_EMAIL", "agent@valaris.dev")

# Personal API key (vlr_...) — simplest auth for end users.
# When set, sends Authorization: Bearer header and skips IAP/email auth.
# Generate keys from the platform Settings page.
API_KEY = os.environ.get("VALARIS_API_KEY", "")

# Set to the IAP client ID to enable Google IAP authentication.
# When set, the client uses ADC (Application Default Credentials) to obtain
# an OIDC token, and X-User-Email is ignored.
# Supported credential types (auto-detected via google.auth.default()):
#   1. Impersonated SA: `gcloud auth application-default login --impersonate-service-account=SA@...`
#   2. SA key file: GOOGLE_APPLICATION_CREDENTIALS pointing to a JSON key
#   3. GCE metadata server: automatic on Compute Engine / Cloud Run
IAP_AUDIENCE = os.environ.get("VALARIS_IAP_AUDIENCE", "")
