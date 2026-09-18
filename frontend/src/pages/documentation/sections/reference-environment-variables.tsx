// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §11,
// backend/app/config.py, mcp-server/src/valaris_mcp/config.py, and
// docs/research/mcp-server.md §4.

import { SectionPage } from "../shell/SectionPage";
import { ImportantNote } from "../callouts";

export function ReferenceEnvironmentVariables() {
  return (
    <SectionPage title="Environment Variables" eyebrow="Reference">
      <p>
        Three processes read environment variables directly: the FastAPI
        backend, the MCP server, and the Go runner (<code>backplane-runner</code>).
        None of them require a full environment to start in dev mode — the
        defaults described below get you a working localhost. These tables
        cover the supported deployment, authentication, integration, event,
        MCP, and runner controls in the current code; one-off test variables
        are not part of this operator contract.
      </p>

      <h2 id="backend">Backend (FastAPI)</h2>
      <p>
        Read from <code>backend/app/config.py</code> via{" "}
        <code>pydantic-settings</code>. Values come from{" "}
        <code>.env</code> or the process environment; environment wins.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Variable
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Default
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Purpose
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>DATABASE_URL</code>
              </td>
              <td className="py-3 pr-4">
                <code>postgresql+asyncpg://valaris:valaris@localhost:5433/valaris</code>
              </td>
              <td className="py-3 pr-4">
                Async SQLAlchemy DSN. Deployed environments point it at their
                Postgres instance. Must use the asyncpg driver.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>DATABASE_PASSWORD</code></td>
              <td className="py-3 pr-4">—</td>
              <td className="py-3 pr-4">
                Optional literal password override for DATABASE_URL. Encoding is automatic.
                Production Compose supplies it from POSTGRES_PASSWORD.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>ENV</code>
              </td>
              <td className="py-3 pr-4">
                <code>development</code>
              </td>
              <td className="py-3 pr-4">
                Gates dev-mode behaviors (swagger exposure, dev-mode auth
                fallback). Set to <code>production</code> in deployed environments.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>CORS_ORIGINS</code>
              </td>
              <td className="py-3 pr-4">
                <code>http://localhost:5173</code>
              </td>
              <td className="py-3 pr-4">
                Comma-separated allowlist. The frontend Cloud Run URL goes
                here in production.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>IAP_AUDIENCE</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                Activates IAP JWT verification. Takes precedence over{" "}
                <code>TRUSTED_PROXY_AUTH</code> when both are set. Prod value
                is the full backend-service resource path.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>TRUSTED_PROXY_AUTH</code>
              </td>
              <td className="py-3 pr-4">
                <code>false</code>
              </td>
              <td className="py-3 pr-4">
                Opt-in to trusting the identity header named by{" "}
                <code>TRUSTED_PROXY_AUTH_HEADER</code> (default{" "}
                <code>X-Goog-Authenticated-User-Email</code>; oauth2-proxy
                users set <code>X-Forwarded-Email</code>). Only safe behind an
                authenticating proxy.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>TRUSTED_PROXY_SECRET</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                Optional handshake for trusted-proxy mode: when set, requests
                must also carry <code>X-Backplane-Proxy-Secret</code> with this
                value. Configure the proxy to inject it.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>AUTH_ALLOWED_EMAIL_DOMAINS</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                Comma-separated domains for verified IAP, trusted-proxy, and
                OIDC identities. It also gates local setup and admin-invite
                paths that create a password-capable account. Empty allows any
                verified domain; API keys and dev mode are exempt.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>AUTH_AUTO_PROVISION</code>
              </td>
              <td className="py-3 pr-4">
                <code>true</code>
              </td>
              <td className="py-3 pr-4">
                Create user accounts on first verified sign-in. <code>false</code>{" "}
                makes the deployment invite-only: IAP and proxy requests for
                unknown users get 403, while the OIDC callback redirects with{" "}
                <code>user_not_provisioned</code>. Neither creates a user row.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>LOCAL_AUTH_ENABLED</code></td>
              <td className="py-3 pr-4"><code>true</code></td>
              <td className="py-3 pr-4">
                Enables database-backed email and password login. A production
                instance using local login also needs{" "}
                <code>OAUTH_STATE_SIGNING_KEY</code> to mint session cookies.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>OIDC_ISSUER</code></td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                OpenID Connect issuer URL. Empty disables OIDC; discovery
                supplies the authorization, token, JWKS, and logout endpoints.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>OIDC_CLIENT_ID</code></td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                Client identifier registered at the OIDC provider. OIDC is
                exposed to the browser only when this, <code>OIDC_ISSUER</code>,
                and <code>OAUTH_STATE_SIGNING_KEY</code> are set.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>OIDC_CLIENT_SECRET</code></td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                Confidential-client secret sent during the authorization-code
                exchange. Keep it out of committed files.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>OIDC_SCOPES</code></td>
              <td className="py-3 pr-4"><code>openid email profile</code></td>
              <td className="py-3 pr-4">
                Space-separated scopes requested from the identity provider.
                The verified ID token must supply an email claim.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>OIDC_SESSION_TTL_SECONDS</code></td>
              <td className="py-3 pr-4"><code>43200</code></td>
              <td className="py-3 pr-4">
                Lifetime for signed browser sessions created by OIDC and local
                password login. Sessions are stateless and expire by age.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>OAUTH_STATE_SIGNING_KEY</code></td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                Signs login sessions plus OIDC and GitHub OAuth state. A
                production instance with local auth or OIDC enabled refuses to
                start when this is empty.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>FRONTEND_URL</code></td>
              <td className="py-3 pr-4"><code>http://localhost:5173</code></td>
              <td className="py-3 pr-4">
                Public browser origin used by login and integration redirects;
                its scheme also decides whether session cookies are Secure.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>EVENT_BUS_BACKEND</code></td>
              <td className="py-3 pr-4"><code>memory</code></td>
              <td className="py-3 pr-4">
                Selects <code>memory</code> for single-process delivery or{" "}
                <code>postgres</code> for cross-instance delivery over Postgres
                LISTEN/NOTIFY. <code>redis</code> is reserved but not implemented.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>CACHE_SINGLE_INSTANCE</code></td>
              <td className="py-3 pr-4"><code>false</code></td>
              <td className="py-3 pr-4">
                Enables Tier-1 process caches. Safe on the memory bus only for
                a genuinely single-instance deployment; the Postgres bus
                distributes eviction events across instances.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>BACKPLANE_TELEMETRY_ENABLED</code></td>
              <td className="py-3 pr-4"><code>false</code></td>
              <td className="py-3 pr-4">
                Opt-in anonymous instance telemetry. It sends nothing unless
                enabled and an endpoint is configured.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>BACKPLANE_TELEMETRY_ENDPOINT</code></td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                Receiver for opt-in telemetry. Empty keeps telemetry a no-op
                even when the enable flag is true.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>API_URL</code>
              </td>
              <td className="py-3 pr-4">
                <code>http://localhost:8000</code>
              </td>
              <td className="py-3 pr-4">
                Operator-facing backend URL baked into exported runner
                bundles (runner YAML and MCP JSON). Set to the public URL in
                prod so exports are launch-ready.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>PORT</code>
              </td>
              <td className="py-3 pr-4">
                <code>8000</code>
              </td>
              <td className="py-3 pr-4">
                Uvicorn bind port. Cloud Run overrides to its injected{" "}
                <code>PORT</code>.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>GCS_BUCKET</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                GCS bucket for resource uploads. Empty falls back to local
                filesystem at <code>LOCAL_STORAGE_DIR</code>.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>GCS_SA_EMAIL</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                Service account email for signed-URL generation. Paired with{" "}
                <code>GCS_BUCKET</code>.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>LOCAL_STORAGE_DIR</code>
              </td>
              <td className="py-3 pr-4">
                <code>data/resources</code>
              </td>
              <td className="py-3 pr-4">
                Local-disk path for resource uploads when GCS isn't configured.
                Persist this directory or volume in self-hosted deployments.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>GITHUB_TOKEN</code>, <code>GITLAB_TOKEN</code>,{" "}
                <code>GITEA_TOKEN</code>
              </td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                Last-resort provider tokens when a workspace has no matching
                stored git connection. Each credential is host-checked; there
                is no cross-provider fallback.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>GITHUB_API_URL</code></td>
              <td className="py-3 pr-4"><code>https://api.github.com</code></td>
              <td className="py-3 pr-4">
                GitHub REST base URL, including GitHub Enterprise deployments.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>ALLOW_GLOBAL_TOKEN_FALLBACK</code></td>
              <td className="py-3 pr-4"><code>true</code></td>
              <td className="py-3 pr-4">
                Allows Git Connections to fall back to the platform token after
                workspace credentials. Disable it for a strict multi-tenant
                posture.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>GIT_USER_NAME</code>, <code>GIT_USER_EMAIL</code>
              </td>
              <td className="py-3 pr-4">
                <code>Backplane Merge Bot</code>,{" "}
                <code>merge-bot@valaris.studio</code>
              </td>
              <td className="py-3 pr-4">
                Commit identity used by the backend merge worker.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>MERGE_QUEUE_STALE_THRESHOLD_SECONDS</code></td>
              <td className="py-3 pr-4"><code>300</code></td>
              <td className="py-3 pr-4">
                Age after which board health reports a non-terminal merge-queue
                entry as stale.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>INTEGRATIONS_TOKEN_KEY</code></td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                Base64-encoded 32-byte Fernet key for encrypting the tokens
                stored by Git Connections. Empty makes token encryption and
                decryption fail loudly instead of storing plaintext.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>GITHUB_OAUTH_CLIENT_ID</code>,{" "}
                <code>GITHUB_OAUTH_CLIENT_SECRET</code>
              </td>
              <td className="py-3 pr-4"><code>""</code></td>
              <td className="py-3 pr-4">
                GitHub OAuth App credentials for workspace git integrations.
                Empty disables the OAuth start endpoint.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>WS_HEARTBEAT_INTERVAL</code>
              </td>
              <td className="py-3 pr-4">
                <code>30</code>
              </td>
              <td className="py-3 pr-4">
                Seconds between server-sent WebSocket heartbeats. Tune only
                if you know why.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>WS_PONG_TIMEOUT</code>
              </td>
              <td className="py-3 pr-4">
                <code>10</code>
              </td>
              <td className="py-3 pr-4">
                Seconds to wait for a client pong before dropping the
                connection.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="mcp">MCP server</h2>
      <p>
        Read from <code>mcp-server/src/valaris_mcp/config.py</code>. Set
        these in the MCP server environment. Claude hosts use the{" "}
        <code>mcpServers.valaris.env</code> block; exported runner configs and
        the runner's isolated Codex config pass the same names.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Variable
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Default
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Purpose
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_API_URL</code>
              </td>
              <td className="py-3 pr-4">
                <code>http://localhost:8000</code>
              </td>
              <td className="py-3 pr-4">
                Base URL of the Backplane backend. Production is the public
                backend Cloud Run URL.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_API_KEY</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                Bearer API key (<code>vlr_...</code>), either personal or linked
                to a registered agent. When set, all other auth paths are skipped and{" "}
                <code>Authorization: Bearer</code> is sent. The simplest
                production config.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_AGENT_EMAIL</code>
              </td>
              <td className="py-3 pr-4">
                <code>agent@valaris.dev</code>
              </td>
              <td className="py-3 pr-4">
                Identity sent in dev-mode auth headers. Ignored when an API
                key or IAP audience is configured.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_IAP_AUDIENCE</code>
              </td>
              <td className="py-3 pr-4">
                <code>""</code>
              </td>
              <td className="py-3 pr-4">
                Target audience for Google ADC OIDC token minting. Set when
                the MCP server is talking to an IAP-gated backend without an
                API key.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>VALARIS_MCP_ALLOWLIST</code></td>
              <td className="py-3 pr-4">unset</td>
              <td className="py-3 pr-4">
                Comma-separated tool ids enforced by the MCP server. The
                allowlist filters both what the model is shown (tools/list)
                and what it may call. Unset, empty, or <code>*</code> means
                unrestricted;{" "}
                <code>__none__</code> denies every tool. Invalid names fail
                server startup rather than silently disabling the gate.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>VALARIS_MCP_TOOLSETS</code></td>
              <td className="py-3 pr-4"><code>default</code></td>
              <td className="py-3 pr-4">
                Comma-separated toolset ids (group or category ids from the
                tool catalog) the server lists and serves. Unset or empty means{" "}
                <code>default</code>, the interactive hand;{" "}
                <code>all</code> loads every tool, which is what runner
                launches pin. Composes with the allowlist as an intersection;
                unknown ids fail server startup.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>MCP_TRANSPORT</code>
              </td>
              <td className="py-3 pr-4">
                <code>stdio</code>
              </td>
              <td className="py-3 pr-4">
                Switch to <code>streamable-http</code> to serve over HTTP
                instead of stdio.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>MCP_HOST</code>
              </td>
              <td className="py-3 pr-4">
                <code>0.0.0.0</code>
              </td>
              <td className="py-3 pr-4">
                HTTP transport bind address. Ignored for stdio.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>MCP_PORT</code>
              </td>
              <td className="py-3 pr-4">
                <code>8001</code>
              </td>
              <td className="py-3 pr-4">
                HTTP transport port. Ignored for stdio.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="runner">The Go runner</h2>
      <p>
        The runner's primary config is its YAML file. A handful of env vars
        override YAML values at startup — useful for container deployments
        where the YAML is a template and the secrets arrive at runtime.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Variable
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                YAML field it overrides
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Purpose
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_API_URL</code>
              </td>
              <td className="py-3 pr-4">
                <code>valaris.api_url</code>
              </td>
              <td className="py-3 pr-4">
                Backend URL the runner authenticates against. Same value the
                MCP server uses.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_API_KEY</code>
              </td>
              <td className="py-3 pr-4">
                <code>valaris.api_key</code>
              </td>
              <td className="py-3 pr-4">
                Bearer key minted for the registered runner. Prefer the env var
                over committing keys to YAML.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>VALARIS_WORKSPACE</code>
              </td>
              <td className="py-3 pr-4">
                <code>valaris.workspace_slug</code>
              </td>
              <td className="py-3 pr-4">
                Workspace scope for the runner. Required through YAML, a named
                profile, or this override.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>VALARIS_WS_ENABLED</code></td>
              <td className="py-3 pr-4"><code>websocket.enabled</code></td>
              <td className="py-3 pr-4">
                <code>false</code> or <code>0</code> force-disables the runner's
                WebSocket client. Other values do not force-enable it.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>VALARIS_NO_SUPERVISOR</code></td>
              <td className="py-3 pr-4">(debug flag)</td>
              <td className="py-3 pr-4">
                <code>1</code> disables panic recovery, matching{" "}
                <code>-no-supervisor</code>. Debug only: a panic terminates the
                process.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>VALARIS_AGENT_EMAIL</code></td>
              <td className="py-3 pr-4">(MCP child identity)</td>
              <td className="py-3 pr-4">
                Inherited by the spawned MCP server for development-header
                identity. It is not a runner YAML override and is ignored when
                the MCP server uses an API key or IAP.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>ANTHROPIC_API_KEY</code>
              </td>
              <td className="py-3 pr-4">
                (not an inherited runner override)
              </td>
              <td className="py-3 pr-4">
                The runner deliberately does not read this env var into config
                and strips an inherited value before spawning{" "}
                <code>claude</code>. To bill API credits, set{" "}
                <code>llm.anthropic_api_key</code> in YAML; leave it empty for
                Claude Max / OAuth.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4"><code>CODEX_API_KEY</code></td>
              <td className="py-3 pr-4">
                (not an inherited runner override)
              </td>
              <td className="py-3 pr-4">
                The Codex driver also strips an inherited key before spawning{" "}
                <code>codex</code>. The current runner config has no general
                YAML field that wires this provider option, so normal runner
                execution must use <code>codex login</code> credentials.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ImportantNote title="API keys don't belong in committed files">
        Every env var named <code>*_API_KEY</code> is a secret. The runner's
        YAML supports <code>${"{VALARIS_API_KEY}"}</code> interpolation
        precisely so the committed config file can stay checked-in while
        the key flows in at process start. Don't paste a real key into a
        committed YAML or MCP config just because "it's internal."
      </ImportantNote>
    </SectionPage>
  );
}
