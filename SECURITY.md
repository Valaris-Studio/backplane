# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately through either channel:

- **GitHub Security Advisories** — [open a private advisory](https://github.com/Valaris-Studio/backplane/security/advisories/new)
  (preferred: it keeps the report, the fix, and the CVE in one place)
- **Email** — security@valaris.studio

Please include: what you found, how to reproduce it, the affected component and
version/commit, and what an attacker could achieve. A proof of concept helps a
lot.

### What to expect

Security support is best-effort, with no guaranteed response time or SLA.
We prioritize reports by severity and impact; critical issues take priority.

We'll keep you updated as we work, credit you in the advisory unless you prefer
otherwise, and let you know when the fix ships. We won't take legal action
against good-faith research that follows this policy.

## Scope

In scope — this repository's code:

- **Backend** (`backend/`) — authentication and authorization, workspace tenancy
  isolation, the scheduler's card-reservation logic, API-key handling
- **Frontend** (`frontend/`) — XSS, token handling, anything that leaks another
  tenant's data into the browser
- **MCP server** (`mcp-server/`) — tool authorization, credential handling
- **Runner** (`runner/`) — command injection through card/branch/repo content,
  credential leakage into logs or agent prompts, sandbox escapes

Especially interested in: **cross-tenant data access** (any path where a member
of workspace A reaches workspace B's data), **authentication bypass**, and
**agent-driven code execution** reaching outside its intended sandbox.

Out of scope:

- Findings that require an already-compromised operator machine or a leaked
  platform API key
- Denial of service through resource exhaustion on a self-hosted instance you
  control
- Missing hardening headers with no demonstrated impact
- The **dev-mode authentication fallback** (`X-User-Email`): dev mode
  intentionally trusts a header so local development needs no identity provider.
  It is not a vulnerability — but a *production* deployment accepting it is, and
  we want to hear about any path that reaches it when `ENV != development`.

## Known security posture

Backplane is an Open Source Preview. Its current security posture is:

- **Production authentication supports four verifiers** — built-in email +
  password login (on by default), generic OIDC, Google Cloud IAP, and an
  explicit trusted-proxy mode — and the backend refuses to start in production
  with none configured. The local password path stores argon2id hashes, answers
  every failed login with one uniform 401 (a locked or unknown account is
  indistinguishable on the wire), throttles login attempts at 10/minute per IP,
  and locks an account for 15 minutes after 5 consecutive failures — lockout
  state lives in the database, so it holds across replicas and restarts. Two
  honest caveats: sessions are stateless signed cookies, so changing a password
  does **not** invalidate sessions minted earlier, and there is no email-based
  reset — recovery is a workspace admin setting a temporary password. This
  surface is newer than the rest of the platform; we especially want reports of
  anything that bypasses the lockout or reaches dev-mode trust in production.
- **Agent-executed code is not strongly sandboxed.** Runners execute coding-agent
  CLIs that run arbitrary commands from card content. Run them on machines you
  are willing to treat as untrusted, with scoped forge credentials.
- **Platform API keys (`vlr_…`) are broad.** Treat them as user-equivalent
  credentials; scope-limiting is on the roadmap.

## Supported versions

Backplane has not cut a stable release yet. Security fixes land on the default
branch. Once stable releases begin, this section will name the supported series.
