# Git Credentials — Connecting Your Own Forge Account

Backplane's **backend merge queue and reconcilers** clone/fetch repos, rebase
and push queued branches, read CI, and land changes on your behalf. To do that
the backend needs a credential for your git host. This guide is for a workspace
owner setting up that backend credential for the first time — no prior
experience with personal access tokens assumed.

Where it lives: **Workspace Settings → Git Connections**.

## Two credential planes — do not substitute one for the other

A workspace Git Connection **does not configure the runner**. Its encrypted
token stays in the backend and is resolved by the merge queue, CI gate,
Done-gate and merged-PR reconciler. **The platform never sends those tokens to the runner**
or to a coding-agent session.

The machine running `backplane-runner` needs its own git transport and forge
credentials to clone/push and to open or directly merge a PR. Depending on the
remote and configured forge, that means a git credential helper or SSH agent,
plus `gh auth login` / `GH_TOKEN`, or the configured Gitea API token. See the
[runner provider and credential guide](../runner/docs/providers.md) for that
independent plane.

Run `backplane-runner -doctor -loop-board BOARD -config runner.yaml` with the
same board, configuration or profile, and source override intended for launch.
In addition to runner-host checks, board-aware doctor asks the backend to check
repository and pull-request reads using its resolved credential, and reports
that credential's source. It also inspects the completion workflow and resume
state without starting paid source work or changing tokens or candidates.

A successful read check does not prove future writes or merges will succeed:
write permissions remain unverified, and credentials or branch rules can change.
Provider runtime checks also do not guarantee a later model request will be
authorized. For a subsequent merge failure, inspect connection health and the
entry's actual credential-source/error message.

## Upgrading an existing install — read this first

Nothing you have configured stops working. The platform's `GITHUB_TOKEN` and
`GITLAB_TOKEN` are still used for repos on github.com and gitlab.com, because
`ALLOW_GLOBAL_TOKEN_FALLBACK` defaults to `true`.

**One exception, and it is a breaking one:**

> ### ⚠️ Self-hosted Gitea via `GITEA_TOKEN` stops getting a credential
>
> `GITEA_TOKEN` is now inert. Gitea has no canonical host, so that token names
> no host, and Backplane will not embed a credential it cannot host-match into
> a clone URL — the rule that stops a registered repo URL from harvesting the
> platform's token.
>
> **If you run self-hosted Gitea, the merge queue will start failing to
> authenticate on the deploy that ships this change.** Fix it in one step:
> add a Gitea connection under **Workspace Settings → Git Connections** with
> `base_url` set to your instance root, per the Gitea section below. Do it per
> workspace that has gitea repos. Leaving `GITEA_TOKEN` in the environment is
> harmless but does nothing.

Also gone: the old cross-provider fallback that handed `GITHUB_TOKEN` to
GitLab and Gitea repos. If you were relying on that (a single GitHub token
covering a GitLab repo), it never actually worked against GitLab's API — but
if any repo depended on it, give that workspace its own connection.

New settings for operators: `INTEGRATIONS_TOKEN_KEY` (required to store any
connection) and `ALLOW_GLOBAL_TOKEN_FALLBACK`. See *Deployment settings* at the
end of this document.

## Which path to take

| | Use it when |
|---|---|
| **GitHub OAuth** ("Connect GitHub") | You're on github.com and the deployment has OAuth configured. Nothing to paste — you approve in the browser. |
| **Access token (PAT)** | Everything else: GitLab, Gitea/Forgejo, self-hosted GitHub, or GitHub when you'd rather scope a token by hand than approve an OAuth app. |

Bitbucket is OAuth-only today — the token path does not accept it yet.

A connection belongs to the workspace, not to you personally. Anyone who can
administer the workspace can manage connections; ordinary members see that a
connection exists (account name, provider, health) but never the token.

## Creating the token

Whatever you paste is encrypted before it touches the database and is never
returned by any API — not to you, not to the frontend, not in an export. If you
lose the original, you re-paste a new one; there is no "show token" button.

### GitHub — fine-grained personal access token (recommended)

1. github.com → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Resource owner**: pick the account or organization that owns the repos
   Backplane will work on. This is the step people get wrong — a token owned by
   your personal account cannot see your organization's repositories, and the
   organization may require an owner to approve the token before it works.
3. **Repository access**: select the specific repositories, or all repositories
   under that owner.
4. **Repository permissions** — set exactly these:

   | Permission | Level | Why |
   |---|---|---|
   | Contents | Read and write | Clone, rebase, force-push the PR branch |
   | Pull requests | Read and write | Read PR state, merge the PR |
   | Actions | Read | Read CI results (see the note below) |
   | Commit statuses | Read | Read CI results published as statuses |

5. Set an expiry you'll actually remember, generate, and copy the token
   (`github_pat_…`). GitHub shows it once.
6. In Backplane: **Add token connection** → provider `github` → paste → save.
   Leave base URL empty for github.com.

**Why Actions read, not Checks?** The natural place to read CI is GitHub's
Checks API, but that API is available to GitHub Apps only — a personal access
token can never call it, and gets a 403 no matter which permissions you grant.
Backplane detects that and falls back to the Actions workflow-runs API, which a
PAT *can* read. That is why "Actions: read" is on the required list and why a
token without it makes every merge-queue entry churn on "ci state unreadable".

### GitHub — classic personal access token

Use a classic token if fine-grained tokens aren't available to you (some
enterprise setups) or the org hasn't approved them.

1. **Settings** → **Developer settings** → **Personal access tokens** →
   **Tokens (classic)** → **Generate new token**.
2. Check **`repo`** (the whole box) and **`workflow`**.
   `repo` covers contents, pull requests, and commit statuses; `workflow` covers
   reading Actions runs.
3. Generate, copy (`ghp_…`), paste into Backplane.

Classic tokens advertise their scopes, so Backplane's Verify can check them
outright — fine-grained tokens disclose nothing, so Verify asks you to confirm
the four permissions by hand instead.

### GitHub Enterprise (self-hosted)

Same token as above, created on your own GitHub instance. In Backplane set
**base URL** to your instance's **API root** — typically
`https://github.acme.com/api/v3`. Getting this wrong is the most common
self-hosted failure: pointing base URL at the web root makes the probe fetch an
HTML page and report a confusing status.

### GitLab

1. gitlab.com (or your instance) → avatar → **Edit profile** → **Access tokens**
   → **Add new token**.
2. Scope: **`api`**. GitLab has no finer split that still allows pushing and
   accepting merge requests, so `api` is what Backplane requires.
3. Set an expiry, create, copy (`glpat-…`).
4. In Backplane: provider `gitlab`, paste. Leave base URL empty for gitlab.com;
   for self-hosted set it to the instance root, e.g. `https://gitlab.acme.com`
   (Backplane appends `/api/v4` itself).

A **project** or **group** access token works too and is the better choice for a
shared workspace — it isn't tied to one person leaving the company. Same `api`
scope.

### Gitea / Forgejo

1. Your instance → **Settings** → **Applications** → **Generate New Token**.
2. Grant **repository read and write** (in newer Gitea, the `repository` and
   `issue`/`pull request` permission groups; older versions issue a single
   all-scopes token).
3. In Backplane: provider `gitea`, paste, and **set base URL to your instance
   root** — e.g. `https://git.acme.com`.

**Base URL is mandatory for Gitea.** There is no canonical Gitea host the way
there is a github.com, so without a base URL Backplane has no way to tell which
host the token belongs to, and refuses to save it rather than storing a
credential it could never safely use. See *Host matching*, below, for why that
rule exists.

## What happens when you save

Backplane calls the forge's "who am I" endpoint with your token before storing
anything:

- **Success** — the account name and type come back from the forge, not from
  anything you typed, and the connection is stored with `last_verified_at` set.
  That account name is what you'll see in the panel and in failure messages.
- **Rejected (401/403)** — nothing is stored. You get the host's own verdict
  plus what to check (expired, revoked, or missing read access to the profile).
- **Unreachable** — nothing is stored. Usually a wrong base URL, a host that
  isn't reachable from where Backplane runs, or TLS trouble.

## Verify, and what its checks mean

The **Verify** button on a connection re-runs the probe and reports a list of
named checks, each with guidance. It also refreshes the connection's health:
success clears any recorded error and stamps `last_verified_at`; failure records
the error, which the panel shows as an unhealthy chip.

| Check | What a pass means | What a fail means |
|---|---|---|
| `identity` | The forge recognized the token and named the account. | The token is expired, revoked, or the host is unreachable — the guidance carries the host's own words. |
| `scopes` | *(Only shown when the forge disclosed nothing.)* | Not a failure of the token — it means Backplane could not read the token's permissions. Normal for every GitHub fine-grained PAT. Confirm the four permissions by hand. |
| `scope:repo` / `scope:api` | The classic-token scope Backplane needs is present. | Re-issue the token with that scope; it cannot be added to an existing one. |
| `ci-read` | The token can read CI state (Actions runs / commit statuses). | The merge queue will churn on "ci state unreadable" until it gives up. Add Actions read + Commit statuses read (fine-grained) or `workflow` (classic). |

Health is also written **from production use**, not just from Verify: when a
merge, a Done-gate check, or the reconciler gets a 401/403 while using a
connection, that connection is marked unhealthy with the real error. That signal
is stronger than a probe — it's what actually happened to a real operation — and
it's the first thing to look at when a merge queue wedges. A subsequent
successful use clears it.

Note that `last_verified_at` is deliberately *not* moved backwards by a
production failure: it answers "when did a probe last succeed", and a later 401
doesn't un-happen that probe.

## Binding a repository to a connection

A repo can name the connection it should use (**board settings → the repo →
connection**, admin only). The connection must be in the same workspace and be
for the same provider.

You only need to bind explicitly when the workspace has **more than one**
connection for that provider — with exactly one, repos use it automatically.

## How Backplane picks a credential

For every backend operation covered by this guide, in order — first match wins:

1. **The connection the repo is bound to.**
2. **The workspace's only connection for that repo's provider.** If there are
   two or more and the repo is bound to none, Backplane refuses to guess: no
   credential, and the failure message names the candidates and tells you to
   bind one.
3. **The platform's own token** (`GITHUB_TOKEN` / `GITLAB_TOKEN` from the
   deployment's environment) — only if the deployment allows it
   (`ALLOW_GLOBAL_TOKEN_FALLBACK`, on by default).
4. **None.** Operations proceed unauthenticated where that can work (a public
   repo clones fine) and explain themselves where it can't.

### Host matching: why a credential sometimes isn't used

At every step above, a credential is used **only if the repository URL's host is
the host that credential was issued for**. A connection's host is its base URL,
or the provider's default (`github.com`, `gitlab.com`, `bitbucket.org`) when it
names none. The platform's `GITHUB_TOKEN` serves github.com only;
`GITLAB_TOKEN` serves gitlab.com only.

This is a security rule, not a convenience one. The token gets embedded into the
clone URL that git contacts, so a credential used against an unmatched host is
handed to that host. Without this rule, registering a repo pointing at any
server you control would make Backplane's merge worker deliver the platform's
token to it.

Two consequences worth knowing:

- **A self-hosted forge needs a connection with a base URL.** There is no env
  token that can serve it, because no env token names a host that matches.
- **There is no cross-provider borrowing.** A GitLab or Gitea repo never
  receives the platform's GitHub token, even on a deployment that has one.

## What a queued landing does

After resolving one of the credentials above, the backend queue clones/fetches
the PR branch, rebases it onto the board's integration branch, and pushes the
rebased branch with `--force-with-lease`. It then lands by provider:

- **GitHub:** validates that the PR targets the integration branch, then uses
  `gh pr merge --squash --delete-branch` with the resolved credential.
- **Other supported connection providers:** fast-forwards the integration
  branch locally with `--ff-only` and pushes it. No forge merge API is called,
  so the host UI can retain a stale-open PR/MR if it does not infer the merge
  from commit ancestry.

This is backend behavior. A pipeline with `merge_via_queue: false` uses the
runner forge driver for its `merge_pr` lifecycle step and therefore uses the
runner's independent credentials described above.

## Troubleshooting

Failure messages name the credential they used — "using workspace connection
`acme-bot`" versus "using platform token" — or, when there was none, the reason
and the fix. Start there; this table maps what you see to what to do.

| What you see | Cause | Fix |
|---|---|---|
| Connection chip shows an error after Verify | The probe was rejected or the host was unreachable. | Read the check guidance. Expired/revoked token → issue a new one. Unreachable → check base URL and network reach. |
| Connection goes unhealthy on its own | A real operation got 401/403 with this connection. | The token expired, was revoked, or lost access to that repo (common after an org membership or repo-visibility change). Issue a new token and re-add. |
| "no credential was used: … has N github connections … not bound to any" | Ambiguous — several connections, no binding. | Bind the repo to one connection in board settings. |
| "no credential was used: repo host X does not match connection Y (Z)" | Host mismatch. | The repo lives on a different host than the connection covers. Add a connection whose base URL is that host. |
| "no credential was used: the platform-wide token fallback is disabled" | Multi-tenant deployment; the workspace must bring its own. | Add a connection for this provider. |
| "no credential is available for X: this workspace has no … connection and the platform has no … token" | Nothing configured anywhere. | Add a connection. |
| "the platform has a gitea token but no way to tell which host it belongs to" | `GITEA_TOKEN` is set on the deployment but names no host. | Add a gitea connection with `base_url` pointing at your instance. The env token cannot substitute. |
| "Cannot determine a host from the repository URL" | The repo URL is malformed. | Fix the repository URL in board settings. |
| Merge-queue entries churn on `ci_not_green (will retry): ci state unreadable` | The token can't read CI. | Add Actions read + Commit statuses read (fine-grained) or `workflow` (classic). If the repo genuinely has no usable CI, set the board's `merge_gate: "none"` — see `docs/loop-mode-contract.md`. |
| Cards stuck in Review, never landing in Done | The Done-gate and reconciler couldn't read the PR, so they soft-passed. Cards get a `verification-deferred` label. | Check the connection's health, and the backend log line naming the board and PR. |
| Saving a gitea token is rejected for a missing base URL | By design — see Gitea above. | Set base URL to the instance root. |

## Deployment settings

For whoever runs the Backplane instance, not the workspace owner. Full
annotations are in `.env.example`.

### `INTEGRATIONS_TOKEN_KEY` — required

A base64 32-byte Fernet key. Every stored forge token is encrypted with it, so
**without it the backend refuses to store a connection at all** — both the
OAuth and the pasted-token path fail. It was previously an OAuth-only concern;
it now gates the whole Git Connections feature.

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

For local `make dev`, put it in the **root** `.env` — `docker-compose.yml`
passes it through to the backend container. When it is unset, the UI disables
"Add token" with a tooltip and the API answers 503 naming the variable;
everything else keeps working.

Treat it like a database credential:

- **Lose it and every stored token is unrecoverable.** There is no escape
  hatch — workspaces re-paste their tokens. Back it up wherever you keep
  `POSTGRES_PASSWORD`.
- **Rotation is decrypt-and-re-encrypt, not a key swap.** Setting a new key
  while old ciphertext is in the database orphans it: connections stay listed
  but no operation can use them, and the failure surfaces inside a merge
  worker. Rotate by decrypting with the old key and re-encrypting with the new
  one, or by deleting the connections and having workspaces re-add them.

It is deliberately distinct from `OAUTH_STATE_SIGNING_KEY` — different threat
model, different rotation cadence.

### `ALLOW_GLOBAL_TOKEN_FALLBACK` — default `true`

Whether a repo with no matching workspace connection may fall back to the
platform's `GITHUB_TOKEN` / `GITLAB_TOKEN`.

- **`true`** (default) — single-tenant behavior, unchanged from before this
  feature. Workspaces that add their own connection use it; the rest fall back.
- **`false`** — the posture for a multi-tenant deployment. Every workspace must
  bring its own credential, and the platform's token is never embedded into a
  tenant's clone URL. Repos without a connection get no credential and fail
  with `fallback_disabled` naming the fix.

Host matching is enforced either way; this switch only controls whether step 3
of the chain is reachable at all.

## Losing a connection

Deleting a connection is immediate and the token is gone. Repos bound to it fall
back down the chain (sole connection → platform token → none), so a merge queue
may quietly change which identity it merges as. Re-adding is a fresh paste — the
old token is unrecoverable by design.
