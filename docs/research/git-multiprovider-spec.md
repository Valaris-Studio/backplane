# Git Multi-Provider Integration Layer — Engineering Spec

**Owner:** Platform / Integrations
**Status:** Ready for scoping
**Target stack:** Python 3.12+ (FastAPI) backend, React 19 / TypeScript frontend
**Providers in scope:** GitHub, GitLab (SaaS + self-hosted), Bitbucket Cloud. Stretch: Azure DevOps, Gitea/Forgejo, Bitbucket Data Center.

---

## 1. Objective

Build a provider-agnostic integration layer that lets our SaaS pipeline connect to any customer's git host, normalize the data into our domain model, and react to events in real time. The frontend talks **only** to our backend — never directly to git providers.

**Explicit non-goal:** a perfect unified API. Git hosts disagree on fundamentals (PR vs MR, reviewers vs approvers, org vs workspace vs group). Ship a pragmatic abstraction with escape hatches, not a universal theory of everything.

---

## 2. Why we're not using an off-the-shelf abstraction

Short version: there isn't a maintained one.

- **IGitt** — abandoned since 2018.
- **git-repo** (guyzmo) — abandoned.
- **GitFleet** — scoped to bulk clone/blame analysis, not PR/issue CRUD.
- **OpenHands `integrations` module** — actually good, covers 6 providers, MIT-licensed. Not a standalone package. **Use as a reference implementation**, not a dependency: https://github.com/All-Hands-AI/OpenHands/tree/main/openhands/integrations

We roll our own thin abstraction on top of each provider's official SDK. ~80% of the code ends up being the normalization layer anyway — the SDKs do the HTTP/auth/retry work.

---

## 3. Architecture

### 3.1 Layered view

```
┌─────────────────────────────────────────────┐
│  React frontend (TanStack Query, no direct  │
│  calls to GitHub/GitLab)                    │
└──────────────────┬──────────────────────────┘
                   │  our REST/BFF API
┌──────────────────▼──────────────────────────┐
│  FastAPI BFF routes (/v1/repos, /v1/prs…)   │
├─────────────────────────────────────────────┤
│  ProviderRouter  ──▶ resolves which adapter │
├─────────────────────────────────────────────┤
│  GitService Protocol (abstract)             │
│  ├── GitHubAdapter   (githubkit)            │
│  ├── GitLabAdapter   (python-gitlab)        │
│  ├── BitbucketAdapter (atlassian-python-api │
│  │                     or raw httpx)        │
│  └── AzureDevOpsAdapter (stretch)           │
├─────────────────────────────────────────────┤
│  Domain models (Pydantic v2) + Webhook      │
│  normalizer + Token vault                   │
└─────────────────────────────────────────────┘
```

### 3.2 Core contract

Define a `GitService` Python Protocol. Every adapter implements it. Keep it small — when in doubt, leave it out.

```python
# app/integrations/service.py
from typing import Protocol, AsyncIterator
from .models import Repository, PullRequest, Branch, Commit, FileBlob, User

class GitService(Protocol):
    provider: str  # "github" | "gitlab" | "bitbucket"

    async def get_user(self) -> User: ...
    async def list_repositories(self, *, cursor: str | None = None) -> tuple[list[Repository], str | None]: ...
    async def get_repository(self, repo_id: str) -> Repository: ...
    async def list_branches(self, repo_id: str) -> AsyncIterator[Branch]: ...
    async def get_file(self, repo_id: str, path: str, ref: str) -> FileBlob: ...
    async def open_pull_request(self, repo_id: str, *, head: str, base: str, title: str, body: str) -> PullRequest: ...
    async def list_pull_requests(self, repo_id: str, *, state: str = "open") -> AsyncIterator[PullRequest]: ...
    async def comment_on_pull_request(self, repo_id: str, pr_id: str, body: str) -> None: ...
    async def get_authenticated_clone_url(self, repo_id: str) -> str: ...
    # Escape hatch — don't pretend everything normalizes
    async def raw(self) -> object: ...  # returns the underlying SDK client
```

**Rules for the team:**
1. Never leak provider-specific types out of an adapter. Always return our Pydantic domain models.
2. `repo_id` is an opaque string from our side. Each adapter picks its own format (`"octocat/hello-world"` for GitHub, numeric project ID for GitLab). Clients treat it as a blob.
3. `raw()` exists for the 5% of cases where a feature only makes sense on one provider (e.g., GitLab approval rules). Document every call site.
4. Async everywhere. No sync libraries in the hot path.

---

## 4. Libraries (2026)

### 4.1 Python backend

| Concern | Pick | Why |
|---|---|---|
| GitHub SDK | **`githubkit`** (0.15+) | Auto-generated from the official OpenAPI spec, fully typed (Pydantic v2), async-native, always current. Supports PAT, OAuth, and GitHub App auth out of the box. |
| GitLab SDK | **`python-gitlab`** (7.x) | Mature, supports REST + sync/async GraphQL, Python 3.10+. |
| Bitbucket | **`atlassian-python-api`** + raw `httpx` | Bitbucket's Python story is weak. `atlassian-python-api` covers basics; use `httpx` for anything it misses. |
| Azure DevOps | **`azure-devops`** (official MS SDK) | Only if we commit to it. API shape is weird — budget extra time. |
| HTTP | **`httpx`** (async) | Standard for 2026. |
| Web framework | **`FastAPI`** (0.115+) | |
| Validation | **`Pydantic v2`** | |
| OAuth client | **`authlib`** | Modern OAuth 2.0 / OIDC client. `Flask-OAuthlib` is deprecated — don't use it. |
| Secrets/tokens | **`cryptography`** + cloud KMS (GCP KMS in our case) | Never store provider tokens in plaintext. |
| Background jobs | **`arq`** or **Celery 5.4+** with Redis | For webhook processing + long pulls. |
| Rate-limit handling | **`tenacity`** for retries, custom token-bucket per provider | See §6. |

**Do not use:** `PyGithub` for new code. It's sync-only, the maintainers are actively asking for help, and `githubkit` is strictly better for anything new. If you find PyGithub in an old service, leave it alone — migration isn't free.

### 4.2 React frontend

| Concern | Pick | Why |
|---|---|---|
| Data fetching | **TanStack Query v5** | Caching, background refetch, optimistic updates. |
| Forms | **React Hook Form + Zod** | Validation schemas shared in spirit with Pydantic. |
| OAuth flow | **Backend-driven redirect** | Frontend never holds provider tokens. `window.location = "/v1/oauth/github/start"` → backend handles the full dance → sets our own session cookie. |
| Types | Codegen from our FastAPI OpenAPI schema via **`openapi-typescript`** | One source of truth. |
| Realtime (webhooks → UI) | **SSE** or WebSockets via FastAPI; push normalized events | Socket.IO if you need rooms/reconnection semantics. |

**Never** ship a GitHub/GitLab token to the browser. Not in localStorage, not in a cookie, not in a header. All provider calls originate server-side.

---

## 5. Authentication: the part that will bite you

Three auth modes per provider. Pick deliberately — this is a product decision as much as a technical one.

### 5.1 GitHub

- **GitHub App (strongly preferred for SaaS)** — per-installation tokens, scoped permissions, 15k req/hr/installation, webhooks bundled in. Customers install the app on their org/repos. This is how Vercel, Linear, Sentry do it. Use `githubkit.GitHubAppAuth` + installation tokens.
- **OAuth App** — user-scoped tokens. Use only if you explicitly need to act as the user.
- **PAT** — debugging and enterprise self-hosted only.

Research: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps

### 5.2 GitLab

- **OAuth 2.0 Application** (SaaS GitLab.com + self-hosted) — main path.
- **Project/Group access tokens** — fine for single-tenant connections.
- **PAT** — debugging and enterprise.

### 5.3 Bitbucket Cloud

- **OAuth 2.0 Consumer** — main path.
- **Repository Access Tokens** — for single-repo integrations.
- **App passwords deprecated June 9, 2026** — do not build on them. Bitbucket is migrating to API tokens + scopes.

Research: Bitbucket deprecation notice + API token migration docs.

### 5.4 Token storage

- Encrypt every token at rest with envelope encryption (KMS-wrapped DEK).
- Store `provider`, `installation_id` or `account_id`, `scopes`, `expires_at`, `refresh_token`.
- Background job refreshes tokens before expiry. Never refresh on the hot path.
- Rotate webhook-signing secrets per customer installation.

---

## 6. Cross-cutting concerns the abstraction must handle

These are the real failure modes. Most "unified APIs" collapse here.

### 6.1 Pagination
Every provider does it differently:
- GitHub: Link header cursors, page+per_page.
- GitLab: same + `X-Next-Page`.
- Bitbucket: opaque `next` URL in body.

Expose `(items, cursor)` tuples or async iterators. Never promise page numbers to callers.

### 6.2 Rate limits
- GitHub REST: 5k/hr (user), 15k/hr/installation (App). Check `X-RateLimit-Remaining`.
- GitHub GraphQL: separate point budget.
- GitLab: 2k/min default for authenticated (varies by instance).
- Bitbucket: 1k/hr workspace-scoped.

Implement per-adapter token buckets. Circuit-break when remaining < 10%. Do not naively retry 429s — honor `Retry-After`.

### 6.3 Webhooks
Separate inbound pipeline from the SDK layer:

```
Provider → /v1/webhooks/{provider} → verify signature → enqueue raw event
                                                               ↓
                                                      WebhookNormalizer
                                                               ↓
                                                  domain event → consumers
```

Critical rules:
- **Verify signature against the raw body**, before any JSON parsing. FastAPI will happily parse the body for you — you want `request.body()` bytes.
- GitHub: `X-Hub-Signature-256`, HMAC-SHA256. Use `hmac.compare_digest`.
- GitLab: plain shared-secret token in `X-Gitlab-Token`. Weaker — compensate with IP allowlist if customer supports it.
- Bitbucket Cloud: no HMAC. Verify by UUID + IP allowlist.
- **Idempotency:** every provider retries. Dedupe by `(provider, delivery_id)` in Redis with a 24h TTL.
- **ACK fast, process async.** Return 2xx within 1s, always. Do the work in a worker.

Research: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

### 6.4 Terminology mapping
Pick our terms and stick to them. Suggested canon:

| Ours | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| `pull_request` | Pull Request | Merge Request | Pull Request |
| `repository` | Repository | Project | Repository |
| `organization` | Organization | Group | Workspace |
| `review` | Review | Approval | Participant approval |
| `default_branch` | `default_branch` | `default_branch` | `mainbranch.name` |

Document this table in the codebase. Junior devs will get it wrong otherwise.

### 6.5 Error normalization
Define our exception hierarchy:
- `GitProviderError` (base)
  - `AuthError` (401/403 from provider)
  - `NotFoundError` (404)
  - `RateLimitError` (429, carries `retry_after`)
  - `ConflictError` (409, merge conflicts etc.)
  - `ProviderUnavailable` (5xx)

Every adapter translates SDK exceptions into these. Callers never import from `github` or `gitlab` modules.

### 6.6 Self-hosted instances
GitLab and Bitbucket have self-hosted deployments. Every adapter must accept a `base_url`. Don't hardcode `https://gitlab.com`. This is a 30-second mistake that costs a week to unwind later.

---

## 7. Domain models (Pydantic v2)

Keep them flat. Resist the urge to model every provider field.

```python
# app/integrations/models.py
from pydantic import BaseModel
from datetime import datetime

class User(BaseModel):
    provider: str
    id: str
    username: str
    email: str | None = None
    avatar_url: str | None = None

class Repository(BaseModel):
    provider: str
    id: str                  # opaque per provider
    full_name: str           # "owner/repo" display form
    default_branch: str
    private: bool
    clone_url_https: str
    updated_at: datetime
    provider_data: dict = {}  # escape hatch

class PullRequest(BaseModel):
    provider: str
    id: str
    number: int
    title: str
    body: str | None
    state: str               # "open" | "merged" | "closed"
    source_branch: str
    target_branch: str
    author: User
    created_at: datetime
    updated_at: datetime
    url: str
    provider_data: dict = {}
```

`provider_data: dict` is intentional. It holds provider-specific fields we haven't normalized yet. Better than forcing premature abstraction.

---

## 8. Frontend responsibilities

- **Connection UX.** "Connect GitHub" button → hits `/v1/oauth/{provider}/start` → redirect → callback → our session established. React never sees the provider token.
- **Repo picker.** Paginated, server-driven. Don't cache provider repo lists client-side longer than the session.
- **Unified PR view.** Consumes our normalized `/v1/pull_requests` endpoint. The UI should not know whether it's a GitHub PR or GitLab MR, except for branding/icons.
- **Live updates.** Subscribe to SSE `/v1/events/stream?repo_id=…`. Backend pushes webhook-derived events.

```typescript
// src/api/prs.ts
import { useQuery } from "@tanstack/react-query";
import type { PullRequest } from "./types.generated"; // from openapi-typescript

export const usePullRequests = (repoId: string) =>
  useQuery({
    queryKey: ["prs", repoId],
    queryFn: async (): Promise<PullRequest[]> => {
      const res = await fetch(`/v1/repos/${encodeURIComponent(repoId)}/pull_requests`);
      if (!res.ok) throw new Error("Failed to load PRs");
      return res.json();
    },
    staleTime: 30_000,
  });
```

---

## 9. Delivery plan

Six two-week sprints. Adjust based on team size.

**Sprint 1 — Foundations**
Define `GitService` Protocol + Pydantic models + exception hierarchy + token vault (KMS integration). No adapters yet. Write adapter contract tests against a fake adapter.

**Sprint 2 — GitHub App auth + read-only adapter**
GitHub App manifest, installation flow, token caching. Implement `get_user`, `list_repositories`, `get_repository`, `list_branches`, `get_file`. Ship behind a feature flag to one internal tenant.

**Sprint 3 — GitHub PR write-path + webhooks**
`open_pull_request`, `comment_on_pull_request`, full webhook receiver + normalizer + SSE fan-out. Contract tests passing end-to-end.

**Sprint 4 — GitLab adapter**
OAuth flow, full adapter, GitLab webhooks. Every contract test that passed for GitHub must pass for GitLab or have a documented waiver.

**Sprint 5 — Bitbucket Cloud adapter + hardening**
OAuth (API-token-based, not deprecated app passwords). Rate-limit instrumentation. Chaos test: kill a provider mid-flight, confirm UX degrades gracefully.

**Sprint 6 — React integration + polish**
Connection UX, unified PR list, live updates via SSE, OpenAPI-generated TS types wired up. Load test.

**Later:** Azure DevOps, self-hosted GitLab validation, Forgejo.

---

## 10. Testing strategy

- **Contract tests** run against every adapter from one suite. If a test passes for GitHub and fails for GitLab, either GitLab has a bug or our contract is wrong — both are valuable findings.
- **Recorded fixtures** with `vcrpy` or `pytest-recording` for SDK interactions. Do not live-hit provider APIs in CI.
- **Webhook replay suite** — capture real webhook payloads per provider, store as fixtures, replay through the normalizer. This is where schema drift bites.
- **At least one full integration test per provider per week** against real sandboxes, run nightly. Alerts on failure.

---

## 11. Things that will go wrong (prepare now)

1. **GitLab self-hosted will be ancient.** Customers run v14. Some endpoints return different fields. Version-detect on connect.
2. **GitHub rate limits under GraphQL** are point-based, not request-based. Easy to blow through with a seemingly-cheap query.
3. **Bitbucket's app-password sunset (June 9, 2026)** — if we launch depending on them, we reship in weeks. Use API tokens from day one.
4. **Webhook payload schema drift.** Providers quietly add fields. Pydantic v2 with `model_config = {"extra": "ignore"}` on webhook models.
5. **Token leakage in logs.** Redact aggressively. Log-scrubbing middleware is mandatory, not nice-to-have.
6. **Clock skew** breaks webhook replay-protection windows. NTP on all workers.

---

## 12. Research / reading list

- OpenHands integrations (reference impl): https://github.com/All-Hands-AI/OpenHands/tree/main/openhands/integrations
- `githubkit` docs: https://github.com/yanyongyu/githubkit
- `python-gitlab` docs: https://python-gitlab.readthedocs.io
- GitHub Apps guide: https://docs.github.com/en/apps
- GitHub webhook validation: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- GitLab webhook docs: https://docs.gitlab.com/ee/user/project/integrations/webhooks.html
- Bitbucket API token migration: https://support.atlassian.com/bitbucket-cloud/docs/api-tokens/
- Authlib OAuth: https://docs.authlib.org/en/latest/
- FastAPI + webhooks pattern (2026): https://www.svix.com/guides/receiving/receive-webhooks-with-python-fastapi/

---

## 13. Definition of done

- All three providers pass the same contract test suite (or have documented, product-approved waivers).
- No provider-specific type ever appears in a FastAPI response model.
- Tokens never logged, never leave the backend, always encrypted at rest.
- Frontend has zero knowledge of which provider a connection is for, except for branding.
- Rate-limit breaches are handled without user-visible errors 99% of the time (measured).
- Webhook-to-UI end-to-end latency p95 < 3s.
