// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §3.1 and
// docs/research/backend-architecture.md §3.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone } from "../callouts";

export function ReferenceApiAuthenticationModes() {
  return (
    <SectionPage title="API Authentication Modes" eyebrow="Reference">
      <p>
        The backend accepts several auth modes, evaluated in a fixed order:
        API key, then the signed session cookie (in production), then dev mode
        (in development), then IAP, then trusted proxy. Whichever signal
        arrives first wins. This lets a single codebase serve dev laptops,
        self-hosted boxes with the built-in password login, OIDC or IAP-gated
        production, and API-key-bearing runners without branching logic at
        every router.
      </p>
      <p>
        On the proxy-verified tiers (IAP, trusted proxy) users are
        auto-provisioned on first authenticated request (unless{" "}
        <code>AUTH_AUTO_PROVISION=false</code>). OIDC applies the same
        provisioning policy during its callback. With local password login,
        accounts come from the first-run setup screen or from a workspace
        admin — there is no self-registration.
      </p>

      <h2 id="the-modes">The modes</h2>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Mode
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                When used
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Header(s) expected
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <strong>API key</strong>
              </td>
              <td className="py-3 pr-4">
                Runners, MCP callers, server-to-server integrations. Preferred
                for any automated caller.
              </td>
              <td className="py-3 pr-4">
                <code>Authorization: Bearer vlr_...</code>
              </td>
              <td className="py-3 pr-4">
                Backend matches the key by prefix + hash. The prefix column is
                stored; the full key is hashed at rest and shown to the user
                exactly once at creation time.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <strong>Dev mode</strong>
              </td>
              <td className="py-3 pr-4">
                Local development only. Active when <code>ENV=development</code>{" "}
                and no bearer token is present.
              </td>
              <td className="py-3 pr-4">
                <code>X-User-Email: you@example.com</code>
              </td>
              <td className="py-3 pr-4">
                Falls back to <code>dev@valaris.dev</code> if the header is
                absent. This fallback is disabled outside development.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <strong>Local password</strong>
              </td>
              <td className="py-3 pr-4">
                Browser traffic on self-hosted instances with no identity
                provider. On by default (<code>LOCAL_AUTH_ENABLED=true</code>);
                needs <code>OAUTH_STATE_SIGNING_KEY</code> to mint sessions.
              </td>
              <td className="py-3 pr-4">
                <code>Cookie: backplane_session=&lt;signed&gt;</code>
              </td>
              <td className="py-3 pr-4">
                <code>POST /api/auth/login</code> verifies an argon2id-hashed
                password and mints the same signed session cookie as OIDC — the
                cookie tier does not care how identity was proven. Every failed
                login is one uniform 401; attempts are throttled per IP and 5
                straight failures lock the account for 15 minutes. See{" "}
                <a href="#local-login">local password login</a> below.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <strong>OIDC session</strong>
              </td>
              <td className="py-3 pr-4">
                Browser traffic when you point Backplane at your own identity
                provider. The login affordance is active only when{" "}
                <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, and{" "}
                <code>OAUTH_STATE_SIGNING_KEY</code> are all set.
              </td>
              <td className="py-3 pr-4">
                <code>Cookie: backplane_session=&lt;signed&gt;</code>
              </td>
              <td className="py-3 pr-4">
                Minted by <code>/api/auth/oidc/callback</code> after an
                authorization-code + PKCE login. Signed with{" "}
                <code>OAUTH_STATE_SIGNING_KEY</code>, httponly, and valid for{" "}
                <code>OIDC_SESSION_TTL_SECONDS</code>. Outranks IAP and trusted
                proxy; an invalid cookie is a rejection, never a fallback to a
                weaker tier.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <strong>IAP (JWT)</strong>
              </td>
              <td className="py-3 pr-4">
                Production browser traffic behind Google IAP. Active when{" "}
                <code>IAP_AUDIENCE</code> is set.
              </td>
              <td className="py-3 pr-4">
                <code>X-Goog-IAP-JWT-Assertion: &lt;es256-jwt&gt;</code>
              </td>
              <td className="py-3 pr-4">
                Backend verifies the JWT against Google's public keys with{" "}
                <code>google.oauth2.id_token.verify_token</code> and extracts
                the email claim. A missing or invalid JWT is a 403, not a
                fallback.
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <strong>Trusted proxy (header)</strong>
              </td>
              <td className="py-3 pr-4">
                Production behind an authenticating proxy (IAP, oauth2-proxy,
                Authelia). Opt-in: set <code>TRUSTED_PROXY_AUTH=true</code>.
                Never automatic.
              </td>
              <td className="py-3 pr-4">
                <code>
                  {"<TRUSTED_PROXY_AUTH_HEADER>: you@example.com"}
                </code>
              </td>
              <td className="py-3 pr-4">
                No signature to verify, so the header is trusted only because
                the proxy is the only thing that can set it. Safe only when the
                backend is unreachable except through that proxy and the proxy
                strips client-supplied copies. Optionally set{" "}
                <code>TRUSTED_PROXY_SECRET</code> and have the proxy inject{" "}
                <code>X-Backplane-Proxy-Secret</code> — requests without the
                matching value are rejected even if they carry the identity
                header. With neither this nor <code>IAP_AUDIENCE</code>,
                production refuses to start.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        Two provisioning knobs apply to verified browser identities (IAP,
        trusted proxy, and OIDC), not to API keys or dev mode:{" "}
        <code>AUTH_ALLOWED_EMAIL_DOMAINS</code> restricts sign-in to a
        comma-separated list of email domains, and{" "}
        <code>AUTH_AUTO_PROVISION=false</code> switches to invite-only. IAP and
        trusted-proxy requests receive HTTP 403 when the verified email has no
        existing account. The OIDC callback redirects with HTTP 302 to{" "}
        <code>{"{FRONTEND_URL}/login?code=user_not_provisioned"}</code> instead;
        it does not return a 403 page from the callback. Neither path creates a
        fresh user row. The domain allowlist also gates the local-auth paths
        that mint a login-capable account: first-run setup and an admin invite
        that grants an initial password (a plain, passwordless membership
        invite is a deliberate act and is not domain-checked). Rejections are
        logged with reason codes such as <code>invalid_iap_jwt</code>,{" "}
        <code>email_domain_not_allowed</code>, and{" "}
        <code>user_not_provisioned</code> so an auth outage is diagnosable from
        logs alone.
      </p>

      <h2 id="headers-by-example">Headers, by example</h2>

      <CodeExample language="http" title="API key — runners and MCP callers">
        {`GET /api/workspaces/acme/boards HTTP/1.1
Host: valaris.example.com
Authorization: Bearer vlr_9a2f...e1c0
Accept: application/json`}
      </CodeExample>

      <CodeExample language="http" title="Dev mode — local laptop only">
        {`GET /api/workspaces/acme/boards HTTP/1.1
Host: localhost:8000
X-User-Email: dev@valaris.dev
Accept: application/json`}
      </CodeExample>

      <CodeExample
        language="http"
        title="IAP JWT — production browser traffic"
      >
        {`GET /api/workspaces/acme/boards HTTP/1.1
Host: backplane.example.com
X-Goog-IAP-JWT-Assertion: eyJhbGciOiJFUzI1NiIsImtpZCI6I...
Accept: application/json`}
      </CodeExample>

      <h2 id="local-login">Local password login</h2>
      <p>
        A fresh instance with an empty <code>users</code> table serves a
        first-run setup screen: the first account created there becomes the
        instance's first user, and the setup route self-closes the moment any
        user exists (it reopens only if the table is ever empty again — an
        empty table means nobody can log in anyway). Passwords are stored as
        argon2id hashes with a 12-character minimum and no composition rules.
      </p>
      <p>
        Brute-force defence is two independent layers: a 10-requests-per-minute
        per-IP throttle on <code>POST /api/auth/login</code>, and a DB-backed
        account lockout — 5 consecutive failures lock the account for 15
        minutes. The lockout lives on the <code>users</code> row, so it holds
        across replicas and restarts, and it expires on its own. On the wire a
        locked account, a wrong password, and a nonexistent email are all the
        same 401; operators can tell them apart from log reason codes.
      </p>
      <p>
        Account management runs through workspace membership: a workspace{" "}
        <strong>owner or admin</strong> can add a member by email with an
        optional initial password (applied only if the account has no password
        yet), and can generate a temporary password for any member of that
        workspace — shown exactly once, and it clears an active lockout. That
        temporary password is the recovery path: there is no SMTP dependency
        and no email-based reset. Everyone can change their own password from
        the sidebar, which requires the current password.
      </p>
      <DangerZone title="Anyone who manages a workspace can create accounts">
        Instance-level authority is deliberately derived from workspace roles —
        there is no separate admin flag. The corollary: on an instance with
        several workspaces owned by different people, each of those owners (and
        their admins) can create instance-wide accounts and set temporary
        passwords for their own members. If that is too broad for your
        deployment, keep workspace ownership narrow. Two more honest notes:
        changing a password does not invalidate sessions minted earlier (the
        cookie is stateless), and admin-set passwords are not flagged
        temporary — nothing forces a rotation on first login.
      </DangerZone>

      <h2 id="oidc-login">Signing in with your own identity provider</h2>
      <p>
        Set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, and{" "}
        <code>OAUTH_STATE_SIGNING_KEY</code> and Backplane runs a backend-driven
        authorization-code flow with PKCE against any OpenID Connect provider
        (Keycloak, Authentik, Google, Entra, Okta). Everything else —
        authorization endpoint, token endpoint, JWKS, logout — is read from the
        issuer's discovery document, so there are no per-endpoint settings to
        drift out of sync. Tokens never reach the browser: the callback verifies
        the ID token server-side and mints a signed session cookie.
      </p>
      <p>
        Register <code>{"{API_URL}/api/auth/oidc/callback"}</code> as the
        redirect URI with your provider. <code>OAUTH_STATE_SIGNING_KEY</code> is
        required — without it no session can be signed, and the login button
        stays hidden.
      </p>

      <CodeExample language="bash" title="Keycloak — realm 'backplane'">
        {`# Keycloak: Clients -> Create client
#   Client ID: backplane
#   Client authentication: On   (confidential client)
#   Valid redirect URIs: https://backplane.example.com/api/auth/oidc/callback
# Copy the generated secret from the Credentials tab.

OIDC_ISSUER=https://keycloak.example.com/realms/backplane
OIDC_CLIENT_ID=backplane
OIDC_CLIENT_SECRET=<from the Credentials tab>
OIDC_SCOPES=openid email profile
OIDC_SESSION_TTL_SECONDS=43200
OAUTH_STATE_SIGNING_KEY=<openssl rand -hex 32>

# Optional tenant boundary — an IdP proves identity, not membership:
AUTH_ALLOWED_EMAIL_DOMAINS=example.com`}
      </CodeExample>

      <CodeExample language="bash" title="Google as the identity provider">
        {`# Google Cloud console -> APIs & Services -> Credentials
#   Create OAuth client ID -> Web application
#   Authorized redirect URI:
#     https://backplane.example.com/api/auth/oidc/callback

OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<client-id>.apps.googleusercontent.com
OIDC_CLIENT_SECRET=<client-secret>
OIDC_SCOPES=openid email profile
OAUTH_STATE_SIGNING_KEY=<openssl rand -hex 32>

# Google will happily authenticate ANY Google account, so restrict the
# domain unless you really mean "anyone with a Gmail address":
AUTH_ALLOWED_EMAIL_DOMAINS=example.com`}
      </CodeExample>

      <DangerZone title="An identity provider proves identity, not membership">
        Every mainstream IdP will authenticate accounts far outside your
        organization — Google signs in any Gmail user, and a Keycloak realm with
        self-registration enabled signs in anyone who fills the form. Unless{" "}
        <code>AUTH_ALLOWED_EMAIL_DOMAINS</code> is set, any successful login
        auto-provisions a Backplane user. Set the domain allowlist, or run
        invite-only with <code>AUTH_AUTO_PROVISION=false</code>.
      </DangerZone>

      <h2 id="websocket-auth">WebSocket auth</h2>
      <p>
        The workspace WebSocket endpoint (<code>/ws/workspaces/&#123;slug&#125;/events</code>)
        accepts the same API key via <code>Authorization</code> on the
        upgrade request. Browser clients are authenticated by whatever
        authenticates their HTTP traffic — the session cookie (browsers send
        cookies on the handshake) or the IAP/proxy headers — so there is no
        extra browser step. A legacy <code>?token=vlr_...</code> fallback is
        still accepted for API keys, but the Authorization header is preferred
        because query strings can land in access logs.
      </p>

      <DangerZone title="API key material is shown exactly once">
        When an authenticated user creates an API key, the full{" "}
        <code>vlr_...</code>{" "}
        string is displayed once in the "API key created" dialog and never
        again. The backend stores only the prefix and a hash. If a key is
        lost, there is no recovery path — revoke it and mint a new one.
        Don't share keys over chat, don't commit them to repos, and don't
        bake them into runner config files that will be checked in. Treat a
        leaked key as an incident: revoke first, investigate second.
      </DangerZone>
    </SectionPage>
  );
}
