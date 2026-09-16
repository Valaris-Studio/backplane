// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Authentication contract: backend/app/core/auth.py and backend/app/main.py.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone, ImportantNote, ProTip } from "../callouts";

export function InstallingSecuringASelfHostedDeployment() {
  return (
    <SectionPage
      title="Securing a Self-Hosted Deployment"
      eyebrow="Installing Backplane"
    >
      <p>
        Backplane ships with built-in email and password login and built-in
        OIDC. It can also verify Google IAP assertions or trust an identity
        header from a proxy you operate. Choose one browser authentication
        topology, keep the backend private, and preserve its signing keys.
      </p>

      <h2 id="authentication-order">How a request is authenticated</h2>
      <p>
        API bearer keys are checked first for runners and MCP clients. Browser
        users authenticate through a signed Backplane session created by local
        login or OIDC. Development identity, Google IAP, and trusted-proxy
        headers are then evaluated according to the configured environment.
        Local login and OIDC are login methods for the same session model, not
        competing per-request verifier tiers.
      </p>
      <p>
        See the internal API Authentication Modes reference for the current{" "}
        <a href="../documentation/api-authentication-modes#local-login">
          local login
        </a>{" "}
        and{" "}
        <a href="../documentation/api-authentication-modes#oidc-login">
          OIDC login
        </a>{" "}
        contracts.
      </p>

      <ImportantNote title="Production fails closed when every verifier is disabled">
        With ENV=production, startup requires local login, OIDC, Google IAP, or
        trusted-proxy authentication. Local login or OIDC also requires
        OAUTH_STATE_SIGNING_KEY. If no production verifier is available, the
        backend exits instead of serving unauthenticated traffic.
      </ImportantNote>

      <h2 id="local-login">Built-in local login</h2>
      <p>
        LOCAL_AUTH_ENABLED=true is the default. A fresh database opens the
        first-run administrator setup, and later accounts are managed through
        the product. Login attempts are rate-limited and repeated failures can
        lock an account. Use a long random OAUTH_STATE_SIGNING_KEY and HTTPS
        before exposing this mode beyond localhost.
      </p>

      <h2 id="oidc">Built-in OIDC</h2>
      <p>
        OIDC is implemented today. Backplane discovers the issuer, uses the
        authorization-code flow with PKCE, validates the response, and mints
        its signed HTTP-only session cookie. A separate authentication proxy
        is not required for this mode.
      </p>
      <CodeExample language="bash" title="Minimum built-in OIDC settings">
        {`OIDC_ISSUER=https://id.example.com/realms/backplane
OIDC_CLIENT_ID=backplane
OIDC_CLIENT_SECRET=<provider-issued-secret>
OIDC_SCOPES=openid email profile
OAUTH_STATE_SIGNING_KEY=<long-random-secret>
BACKPLANE_URL=https://backplane.example.com

# Register this redirect URI with the provider:
# https://backplane.example.com/api/auth/oidc/callback`}
      </CodeExample>
      <p>
        The callback is built from API_URL and ends in
        /api/auth/oidc/callback. In the production Compose file, BACKPLANE_URL
        supplies API_URL, so the public URL and the provider's registered
        redirect must agree exactly.
      </p>

      <h2 id="iap-and-proxy">Google IAP and trusted proxy</h2>
      <ul>
        <li>
          IAP_AUDIENCE enables verification of the signed
          X-Goog-IAP-JWT-Assertion and its email claim.
        </li>
        <li>
          TRUSTED_PROXY_AUTH=true trusts the header named by
          TRUSTED_PROXY_AUTH_HEADER. The default header is
          X-Goog-Authenticated-User-Email and has no application-level
          signature, so network isolation and header replacement are required.
        </li>
        <li>
          TRUSTED_PROXY_SECRET adds X-Backplane-Proxy-Secret as a shared
          defense, and AUTH_ALLOWED_EMAIL_DOMAINS narrows accepted identities.
        </li>
        <li>
          AUTH_AUTO_PROVISION controls whether a verified new email becomes a
          user. When false, unknown identities receive 403
          user_not_provisioned instead of an account.
        </li>
      </ul>

      <DangerZone title="A trusted header is safe only behind an enforced proxy">
        When AUTH_AUTO_PROVISION=true, a verified IAP or trusted-proxy email can
        create its user on first request. If clients can reach the backend
        around that verifier, or can preserve their own identity header, the
        security boundary is broken. Publish only the intended frontend or
        proxy entry point and strip incoming identity headers before setting
        the trusted value.
      </DangerZone>

      <h2 id="external-proxy">An external OIDC proxy remains an alternative</h2>
      <p>
        oauth2-proxy, Authelia, or a similar gateway can own browser login and
        forward a verified email to Backplane. This is useful when one gateway
        already protects several applications, but it is not required merely
        to obtain OIDC support.
      </p>
      <CodeExample language="bash" title="Trust an oauth2-proxy email header">
        {`TRUSTED_PROXY_AUTH=true
TRUSTED_PROXY_AUTH_HEADER=X-Forwarded-Email
AUTH_ALLOWED_EMAIL_DOMAINS=example.com
AUTH_AUTO_PROVISION=false
BACKPLANE_URL=https://backplane.example.com`}
      </CodeExample>

      <h2 id="secrets">Protect and restore secrets</h2>
      <p>
        OAUTH_STATE_SIGNING_KEY signs login sessions and OAuth or OIDC state.
        INTEGRATIONS_TOKEN_KEY encrypts stored git-provider tokens. Provider
        credentials and forge tokens can authorize external actions. Keep .env
        out of git, restrict access, back it up encrypted, and rotate exposed
        values deliberately.
      </p>

      <ProTip title="Test both the login path and the bypass path">
        Confirm a permitted identity can log in and a disallowed identity is
        rejected. Then try to reach backend and frontend ports outside the
        intended proxy path from another host. A working login page does not
        compensate for a direct unauthenticated route.
      </ProTip>
    </SectionPage>
  );
}
