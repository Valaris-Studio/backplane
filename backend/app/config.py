# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # 5433 is the host port dev compose publishes Postgres on
    # (docker-compose.yml maps 5433:5432); containerized deployments always
    # override this via env, so this default exists for native
    # `make dev-backend` runs.
    DATABASE_URL: str = "postgresql+asyncpg://valaris:valaris@localhost:5433/valaris"
    CORS_ORIGINS: str = "http://localhost:5173"
    ENV: str = "development"
    GCS_BUCKET: str = ""
    GCS_SA_EMAIL: str = ""
    LOCAL_STORAGE_DIR: str = "data/resources"
    IAP_AUDIENCE: str = ""
    # Opt-in to trusting a proxy-supplied identity header (no signature to
    # verify). Only safe when the backend is reachable exclusively through an
    # authenticating proxy that strips client-supplied copies of the header —
    # otherwise anyone can name themselves anyone. Production refuses to start
    # with neither this nor IAP_AUDIENCE; see create_app's startup gate.
    TRUSTED_PROXY_AUTH: bool = False
    TRUSTED_PROXY_AUTH_HEADER: str = "X-Goog-Authenticated-User-Email"
    # Optional handshake for trusted-proxy mode: when set, requests must also
    # carry X-Backplane-Proxy-Secret with this exact value (the proxy injects
    # it). Defends the identity header against clients that can reach the
    # backend port directly. Empty = handshake off.
    TRUSTED_PROXY_SECRET: str = ""
    # Comma-separated email domains allowed to sign in via IAP / trusted-proxy
    # (API keys and dev mode are exempt). Verifiers prove identity, not
    # membership — this is the tenant boundary. Empty = allow all domains.
    AUTH_ALLOWED_EMAIL_DOMAINS: str = ""
    # Create a User row on first sight of a verified email. Disable for
    # invite-only deployments: unknown emails then get 403 until a row exists.
    AUTH_AUTO_PROVISION: bool = True
    # Email + password login with credentials stored in Backplane's own
    # database (argon2id). ON by default: it is what lets a self-hoster run
    # production with no IdP, no IAP, and no fronting proxy — create_app's
    # startup gate accepts it as a verifier (docs/plans/local-auth.md, L4).
    LOCAL_AUTH_ENABLED: bool = True
    # Generic OIDC login (any IdP with a discovery document: Keycloak,
    # Authentik, Google, Entra, Okta). Empty OIDC_ISSUER = feature off.
    # Discovery, JWKS and endpoints are all derived from the issuer, so there
    # are no per-endpoint knobs to drift out of sync with the IdP.
    OIDC_ISSUER: str = ""
    OIDC_CLIENT_ID: str = ""
    OIDC_CLIENT_SECRET: str = ""
    OIDC_SCOPES: str = "openid email profile"
    # Lifetime of the signed session cookie minted after ANY successful
    # login — local password auth and first-run admin setup included, not
    # just OIDC. Revocation story is expiry-based (no session table), so
    # keep it short.
    OIDC_SESSION_TTL_SECONDS: int = 43200
    # Anonymous instance telemetry. OPT-IN: ships disabled, so a self-hoster
    # who never touches this never phones home. When enabled the payload is an
    # instance id (a one-way hash of DATABASE_URL), the version, and two coarse
    # counts — see app/services/telemetry.py, whose tests assert that nothing
    # identifying can ride along.
    BACKPLANE_TELEMETRY_ENABLED: bool = False
    # No default endpoint: the receiving service does not exist yet, and
    # shipping a URL that 404s would be dishonest. Until one is stood up,
    # enabling telemetry without also setting this is a no-op by construction.
    BACKPLANE_TELEMETRY_ENDPOINT: str = ""
    # EventBus backend selection (memory | postgres). The bus factory reads the
    # raw env var at module import (the singleton exists before Settings is
    # guaranteed constructed) — this field mirrors it so the knob is documented
    # and the cloudbuild↔Settings drift guard sees it. Values always agree:
    # both read the same environment variable.
    EVENT_BUS_BACKEND: str = "memory"
    # Opt-in for Tier-1 in-process caches (app/core/cache.py) on the memory bus.
    # They are cross-instance-correct only under EVENT_BUS_BACKEND=postgres,
    # where eviction events reach every instance; on the memory bus an eviction
    # is local, so a second instance would serve stale reads. Default False
    # keeps the zero-config deployment pass-through — set it only when the
    # deployment is genuinely single-instance (maxScale=1).
    CACHE_SINGLE_INSTANCE: bool = False
    PORT: int = 8000
    # Operator-facing backend URL baked into exported runner bundles
    # (runner YAML `valaris.api_url` + MCP JSON `VALARIS_API_URL`). Dev
    # default is localhost; prod overrides this via env var so exports
    # are launch-ready without hand-editing. See B13.
    API_URL: str = "http://localhost:8000"
    WS_HEARTBEAT_INTERVAL: int = 30
    WS_PONG_TIMEOUT: int = 10
    GITHUB_TOKEN: str = ""
    GITHUB_API_URL: str = "https://api.github.com"
    # Per-provider clone/fetch/push tokens, the LAST step of
    # CredentialResolver's chain (a workspace's own git_connection wins first).
    # There is deliberately no cross-provider fallback: a non-github repo with
    # no token here gets none, rather than being handed GITHUB_TOKEN — that
    # older behavior embedded the platform's GitHub PAT into gitlab/gitea clone
    # URLs. Every token here is host-checked before use, so GITEA_TOKEN (which
    # names no canonical host) only ever serves a connection that pins one.
    GITLAB_TOKEN: str = ""
    GITEA_TOKEN: str = ""
    # Kill switch for the last step of CredentialResolver's chain. With it off,
    # a repo whose workspace has no matching git_connection gets NO credential
    # at all rather than silently borrowing the platform's env token — the
    # posture a multi-tenant deployment wants once workspaces own their creds.
    # Default True so single-tenant deployments keep working unchanged.
    ALLOW_GLOBAL_TOKEN_FALLBACK: bool = True
    # Identity used by the backend merge worker when authoring rebase /
    # squash-merge commits. Defaults are safe for dev; prod overrides via env
    # so audit trails attribute the merge to the platform, not the operator.
    GIT_USER_NAME: str = "Backplane Merge Bot"
    GIT_USER_EMAIL: str = "merge-bot@valaris.studio"
    # How long a merge-queue entry may sit in a non-terminal state before board
    # health reports it as stuck. Tuned above a normal merge's wall time so a
    # healthy queue never trips it; the 2aa905f worker-rollback incident sat at
    # `queued` for 70+ minutes with nothing surfacing it.
    MERGE_QUEUE_STALE_THRESHOLD_SECONDS: int = 300
    # Base64-encoded 32-byte Fernet key used by FernetTokenVault to encrypt
    # OAuth access/refresh tokens at rest in `git_connections`. Empty in dev
    # means the vault refuses to encrypt or decrypt — fail loud so we never
    # persist plaintext tokens. Generate with `Fernet.generate_key().decode()`.
    INTEGRATIONS_TOKEN_KEY: str = ""
    # GitHub OAuth App credentials for the multi-provider integrations layer.
    # Empty in dev disables `/api/workspaces/{slug}/oauth/github/start` (the
    # endpoint 503s rather than redirecting nowhere). Provision a GitHub OAuth
    # App with callback `{API_URL}/api/oauth/github/callback`.
    GITHUB_OAUTH_CLIENT_ID: str = ""
    GITHUB_OAUTH_CLIENT_SECRET: str = ""
    # Signing key for the short-lived OAuth state cookie (itsdangerous).
    # Distinct from INTEGRATIONS_TOKEN_KEY because that one is symmetric
    # encryption and this is HMAC signing — different threat models, different
    # rotation cadence. Empty disables the OAuth start endpoint.
    OAUTH_STATE_SIGNING_KEY: str = ""
    # Origin the OAuth callback redirects back to once the connection is
    # persisted. Defaults to the dev Vite origin; production overrides via env
    # to the IAP-fronted Cloud Run host.
    FRONTEND_URL: str = "http://localhost:5173"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",")]

    @property
    def is_development(self) -> bool:
        return self.ENV == "development"

    @property
    def session_cookie_secure(self) -> bool:
        # Secure iff the public origin is https. "Always Secure in production"
        # bricked plain-http self-hosts (http://<lan-ip>:8080): browsers drop
        # Secure cookies over http everywhere except localhost, so a correct
        # login silently bounced back to the form. FRONTEND_URL is the origin
        # browsers actually use (prod compose derives it from BACKPLANE_URL).
        return self.FRONTEND_URL.startswith("https://")

    # extra="ignore": .env is shared with docker compose, which owns keys the
    # backend never reads (POSTGRES_PASSWORD, BACKPLANE_URL, ...). Typo
    # protection for real settings lives in test_env_example_drift.py.
    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
