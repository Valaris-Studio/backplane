<img src="frontend/public/brand/logo-light.png" alt="Backplane" width="200">

# Backplane

**Shared project context and work coordination for people and their coding agents.**

Keep project definitions, cards, notes and decisions together. Work with your
team in the app, connect your own coding agent through MCP, and review its work
against the same shared context. Optional runners execute workflows you configure
and report their progress, results and costs.

Backplane supplies no intelligence: you bring your own agents. The platform owns
configuration, scheduling, prompts and authorization; runners execute that
contract. You choose roles, providers, budgets and approval gates. Runners can
work in separate Git branches and open pull requests, but execute agent commands
on their host. See [Known security posture](SECURITY.md#known-security-posture).

It is coding-agent agnostic (Claude Code and Codex CLI today) and git-forge
agnostic (GitHub and Gitea today).

> **Backplane — Open Source Preview.** You can self-host it and connect your own
> coding agents. APIs and workflows may evolve as we incorporate feedback.
> **Runners are experimental.** Start with [Self-hosting](#self-hosting) for the
> production configuration with local login; the development Quickstart below
> uses automatic authentication. See [Known limitations](#known-limitations)
> before planning a deployment.

<!-- SCREENSHOT: board view with cards in flight -->
<!-- SCREENSHOT: pipeline builder canvas -->
<!-- SCREENSHOT: runner console / execution timeline -->
<!-- SCREENSHOT: first-run setup screen (local login) -->
<!-- SCREENSHOT: login screen with password form -->

## What it is not

- **Not an agent or a model.** It orchestrates coding agents; it doesn't contain
  one. You bring Claude Code or Codex CLI and your own API credentials.
- **Not a full project-management suite.** Boards, notes and shared context are
  useful on their own; connecting an agent or running automation is optional.
- **Not autonomous-by-default.** Approval gates, budget caps, and human review
  modes are first-class, and on by default where it matters.

## How it fits together

| Component | What it is |
|---|---|
| `backend/` | FastAPI + SQLAlchemy API — workspaces, boards, cards, executions, the scheduler that decides which runner gets which card |
| `frontend/` | React + Vite web app — boards, pipeline builder, runner console, live observer |
| `mcp-server/` | MCP server exposing the platform tool catalog to AI agents — on PyPI as [`backplane-mcp`](https://pypi.org/project/backplane-mcp/) ([README](mcp-server/README.md)) |
| `runner/` | The autonomous runner (Go) — polls for work, drives the coding agent, pushes branches, opens PRs |
| `docs/` | References and historical design documents; follow each document's status notice |
| `infra/`, `scripts/` | Provisioning and dev/smoke scripts |

The four surfaces are independent: you can drive the platform entirely through
the MCP server from your own agent and never run the Go runner at all.

## Quickstart

**Prerequisites**

| Tool | Version | Needed for |
|---|---|---|
| Docker + Compose | any recent | the Quickstart — the whole stack runs in containers |
| Python | 3.12+ | native backend / MCP server development |
| Node | 22 | native frontend development |
| pnpm | 11.5.1 | native frontend development |
| Go | 1.26+ | building the runner from source |
| uv | any recent | running the MCP server a runner talks to (see `runner/README.md`) |

The Quickstart needs Docker plus the basics you already have to clone a repo:
git, make, bash, and curl (the Makefile runs its recipes with bash, and the
`doctor` / `quickstart-gate` helpers use bash and curl directly; `lsof` improves
their port checks when present). The rest of the table is for developing those
surfaces outside Docker.

`make dev` runs in the foreground and keeps streaming logs, so the optional
seed goes in a second terminal.

```bash
# Terminal A
git clone https://github.com/Valaris-Studio/backplane.git
cd backplane
cp .env.example .env      # defaults work for local dev as-is
make dev                  # Postgres :5433 + backend :8000 + frontend :5173
```

Wait for `Application startup complete` from the backend and `VITE ready` from
the frontend — the backend runs its migrations on startup, so first boot takes
a little longer.

```bash
# Terminal B (optional)
make seed-demo            # a sample workspace + populated board
```

Open **http://localhost:5173**. In dev mode you are authenticated automatically
as `dev@valaris.dev` — no signup flow.

**Stopping and restarting**

`Ctrl+C` in Terminal A stops the stack; your database survives in a Docker
volume, so `make dev` picks up where you left off. To throw everything away,
`make clean` — it runs `docker compose down -v` and also removes local
`node_modules` and build output. **That deletes your database.**

`make seed-demo` gives you something to click through instead of an empty
screen. It is safe to re-run, and it refuses to add demo data to an instance
that already holds real work (pass `FORCE=1` to override).

Not sure if the stack actually came up cleanly? `make doctor` prints a
one-shot health readout — container health, listening ports, endpoint probes,
and migration head — the quick answer to "is my stack actually up?"

API docs (Swagger UI): **http://localhost:8000/api/docs**

**Running the tests**

The test targets run natively, not in Docker — they need the native setup
(Python 3.12 venv, pnpm, Go) from
[`CONTRIBUTING.md`](CONTRIBUTING.md#dev-setup) first. Fresh from the
Docker-only Quickstart, `make test` fails with a missing `backend/.venv`;
that's the missing native setup, not a broken checkout.

```bash
make test        # backend pytest (authoritative, serial)
make test-fast   # backend pytest -n auto -m "not slow" (inner loop)
make mcp-test    # MCP server pytest
make runner-test # runner Go tests — drive REAL git (clone/reset), but this
                 # target is safe-by-construction: scripts/go-test-safe.sh
                 # copies runner/ out-of-tree before running go test. Only a
                 # bare `go test` run by hand from inside runner/ is still
                 # dangerous.

make quickstart-gate # verifies the fresh-clone Quickstart above end-to-end.
                      # Self-contained: copies the checkout to a temp dir and
                      # uses disposable containers/volumes on randomized ports,
                      # so it's safe to run while `make dev` is up (CI runs it
                      # nightly). Needs Docker only.
```

**Adding a runner** is a separate step — you need a coding-agent CLI on PATH and
forge credentials. In the app, it's the **Launch runner wizard** at **Runner →
Runners → Create runner**, which walks Identity → Roles → Config → Launch and
ends with the command that starts the binary. The full write-up is in the in-app
documentation (**Documentation → Getting Started → Registering a Runner**), also
readable at `/documentation` without creating a workspace, and mirrored in
[`runner/README.md`](runner/README.md#quickstart). If `~/.claude.json` doesn't
exist yet, `touch ~/.claude.json` before your first `make dev-runner` —
otherwise Docker creates a root-owned directory at that path instead of
bind-mounting the file.

## Self-hosting

The production stack is one compose file — Postgres, backend, frontend — with
local password login on by default and no cloud dependency:

```bash
git clone https://github.com/Valaris-Studio/backplane.git
cd backplane
cp .env.example .env
# in .env, fill in the two required secrets:
#   POSTGRES_PASSWORD          — any strong value
#   OAUTH_STATE_SIGNING_KEY    — generate with: openssl rand -hex 32
# browsing from another machine? also set BACKPLANE_URL=http://<host-ip>:8080
docker compose -f docker-compose.prod.yml up -d
```

Open **http://localhost:8080** — or your `BACKPLANE_URL` (port override:
`BACKPLANE_HTTP_PORT`). A fresh instance shows a first-run screen to create
the admin account; after that it's the normal login page. Backend and frontend
build from source on the first `up` — no published images — and database
migrations run automatically on startup, no manual step.

The first `up -d` builds both images from source and then runs migrations, so
it can take a few minutes before anything answers — the frontend won't accept
traffic until the backend reports healthy, so you'll see nothing rather than a
half-broken page in the meantime. Watch progress with
`docker compose -f docker-compose.prod.yml logs -f backend`, and check
`docker compose -f docker-compose.prod.yml ps` — services show `(healthy)`
once ready. If backend instead cycles between `unhealthy` and `restarting`,
that's a migration or startup crash-loop; the backend logs above are where to
look.

Optional: seed the same demo workspace as dev — pass the email of the account
you created at first run so it gets owner access to the seeded workspace:

```bash
docker compose -f docker-compose.prod.yml exec -T backend python -m scripts.seed_demo --email you@example.com
```

Hardening an internet-facing deployment (TLS, proxies, OIDC) is covered in [`SECURITY.md`](SECURITY.md) and the in-app
documentation's *Securing a Self-Hosted Deployment* section.

## Documentation

The full documentation ships **inside the app** — around 50 sections covering
core concepts, configuration of every pipeline field, operations, architecture,
and an honest "rough edges" section. Run the stack and open
[`/documentation`](http://localhost:5173/documentation).

Reference material also lives in-repo:

| Doc | What's in it |
|---|---|
| [`docs/platform-source-of-truth.md`](docs/platform-source-of-truth.md) | Historical architecture reference; current behavior is documented in-app |
| [`docs/pipeline-config-reference.md`](docs/pipeline-config-reference.md) | Historical pipeline design reference; use in-app documentation for current fields |
| [`docs/events.md`](docs/events.md) | Event taxonomy |
| [`docs/git-credentials.md`](docs/git-credentials.md) | Connecting a workspace's own forge account — per-provider tokens, scopes, troubleshooting |
| [`runner/docs/providers.md`](runner/docs/providers.md) | Coding-agent and forge providers |
| [`docs/api/openapi.json`](docs/api/openapi.json) | Exported REST API schema — browse it via [`docs/api/index.html`](docs/api/index.html) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution policy, dev setup, architecture rules, TDD workflow |

Any running instance serves the same API contract live: Swagger UI at `/api/docs`
in dev, and the machine-readable schema at `/api/openapi.json`. Regenerate the
checked-in copy with `python scripts/export-openapi.py` (backend venv active).

## Known limitations

Being upfront, because these decide whether Backplane fits you today:

- **Authentication is young.** Local email + password login works out of the box
  (on by default): a fresh instance opens with a first-run admin setup screen,
  failed logins are throttled per IP and lock the account after 5 straight
  misses, and workspace admins manage accounts — no identity provider or
  fronting proxy required. Generic OIDC (Keycloak, Authentik, Google, Entra,
  Okta), Google Cloud IAP, and an explicit trusted-proxy mode also work, and
  production refuses to start with no verifier at all. But the whole surface
  has far less mileage than the rest of the platform — treat a first deployment
  as something to verify, not assume. SAML, SCIM, enforced MFA and email-based
  password reset are not implemented; password recovery is a workspace admin
  setting a temporary password.
- **Object storage** defaults to local disk; the alternative path is Google Cloud
  Storage. No S3 driver yet.
- **The backend and frontend ship as source, not images** — self-hosting builds
  them locally via docker compose. The client artifacts *are* released: the
  runner as a multi-arch image (`ghcr.io/valaris-studio/backplane-runner`) and
  as standalone binaries with checksums
  ([darwin/linux/windows × arm64/amd64](https://storage.googleapis.com/backplane-artifacts/runner/v0.8.4/SHA256SUMS)),
  and the MCP server via `uvx backplane-mcp`.
- **GitLab PAT connections are supported** for repository credentials and the
  backend merge-queue plumbing. The runner forge driver for GitLab does not yet
  open, review, or merge merge requests; those lifecycle operations currently
  support GitHub and Gitea.

## Telemetry

**Backplane does not phone home.** There is no analytics, no usage tracking, and
no outbound call of any kind unless you switch one on.

There is also no collector to send to yet — `BACKPLANE_TELEMETRY_ENDPOINT` ships
empty, so flipping the flag on its own still sends nothing. If and when a
collector exists this section will say so plainly.

Setting `BACKPLANE_TELEMETRY_ENABLED=true` *and* naming an endpoint opts into a
periodic anonymous ping containing exactly five fields: a hashed instance id (derived one-way from your
`DATABASE_URL`, so it cannot reveal your credentials or hostname), the Backplane
version, the Python version, and how many users and workspaces exist. No names,
emails, workspace slugs, card content, repository URLs, or prompts — ever. The
payload is built in one short function, `backend/app/services/telemetry.py`, and
its tests assert that identifying data cannot leak into it.

## Contributing

**Backplane is maintained solely by the Valaris team and is not accepting outside
code contributions yet.** Pull requests from outside the team will be closed
unreviewed — we have no contributor agreement in place and would rather say so
before you spend the time than after.

**Issues are open and wanted**: bug reports, feature requests, and questions all
help. Security reports go privately via [`SECURITY.md`](SECURITY.md), never a
public issue. The licenses permit forks — fork freely.

We expect to open up to contributions once the architecture settles;
[`CONTRIBUTING.md`](CONTRIBUTING.md) carries the current policy alongside the dev
loop, the layering rules (Router → Service → Repository → Model), and the
test-first expectation.

## License

Per-component, mapped in **[`LICENSES.md`](LICENSES.md)**:

- Platform core (`backend/`, `frontend/`, `mcp-server/`) — **AGPL-3.0-or-later**
- The runner (`runner/`) — **MIT**
- API / OpenAPI / MCP tool schemas — **Apache-2.0**

Third-party dependencies, including one documented non-OSI exception (GSAP), are
covered in [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

## Naming

The platform is **Backplane**. The `valaris` MCP namespace and `VALARIS_*`
environment variables are stable technical identifiers and are intentionally not
renamed — changing them would break every existing agent configuration. Full
policy: [`docs/branding.md`](docs/branding.md).
