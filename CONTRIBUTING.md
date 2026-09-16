# Working on Backplane

## ⚠️ Backplane is not accepting outside code contributions right now

Backplane is developed and maintained solely by the Valaris team. **We are not
accepting pull requests from outside the team**, and PRs opened against this
repository will be closed unreviewed — not because the work isn't good, but
because we have no contributor-licensing agreement in place and no capacity to
review external changes at the standard we hold ourselves to. Closing a PR
someone spent hours on is a worse outcome than saying this plainly up front.

**What we do want from you:**

- **Bug reports** — [open an issue](https://github.com/Valaris-Studio/backplane/issues/new/choose).
  A reproducible report is genuinely more useful to us than a patch right now.
- **Feature requests and questions** — use
  [GitHub Issues](https://github.com/Valaris-Studio/backplane/issues/new/choose).
- **Security reports** — privately, via [`SECURITY.md`](SECURITY.md). Never a public issue.
- **Forks** — the licenses ([`LICENSES.md`](LICENSES.md)) permit them. Fork freely;
  just don't expect us to merge changes back yet.

This is a deliberate choice for the project's early stage, and we expect to
revisit it once the architecture settles and we have a contributor agreement
sorted. When that changes, this file changes with it.

Community support is best-effort, without a guaranteed response time or SLA.

The rest of this document is how the codebase expects to be worked on. It is
written for the maintaining team, and is public because it is also the honest
answer to "how does this thing fit together" — useful if you are reading the
source, self-hosting, or running a fork.

## Before you start

- **Check the license of the component you're touching.** The repo is
  per-component licensed (AGPL core, MIT runner, Apache schemas) — see
  [`LICENSES.md`](LICENSES.md).

## Dev setup

```bash
git clone https://github.com/Valaris-Studio/backplane.git
cd backplane
cp .env.example .env
make dev        # Postgres :5433 + backend :8000 + frontend :5173
```

`make dev` runs in the foreground; use a second terminal for anything else.
Migrations run automatically on backend startup — `make migrate` is for the
native (non-Docker) backend flow below and needs `backend/.venv` to exist.

Working outside Docker on individual components:

| Component | Setup | Tests |
|---|---|---|
| Backend | `cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt` | `make test` (serial, authoritative) / `make test-fast` (parallel inner loop) |
| Frontend | `cd frontend && pnpm install` | `pnpm test`, `pnpm lint`, `pnpm build` |
| MCP server | `make mcp-install` (creates `mcp-server/.venv`) | `make mcp-test` |
| Runner | Go 1.26+ | `make runner-test` |

Requires Python 3.12+, Node 22, pnpm 11.5.1, Go 1.26+.

The native backend (`make dev-backend`) has no compose network, so it needs a
reachable Postgres — the compose Postgres on `:5433` matches the `Settings`
default, so `make dev` (or just `docker compose up postgres`) is enough,
with no `DATABASE_URL` override required. For native-only backend overrides,
copy `.env.example` to `backend/.env` rather than the repo root: the backend
process reads `.env` relative to its own working directory.

## Test-first is not optional

**Every feature and bug fix starts with a failing test.**

1. Write a test that describes the expected behavior and fails for the right reason.
2. Write the minimum code to make it pass.
3. Refactor while it stays green.

A PR that changes behavior without a test that would have caught the old
behavior will be asked for one. This is the single most important rule here — the
platform coordinates autonomous agents, and untested coordination logic fails in
ways that are expensive and hard to reproduce.

### Test conventions

- **Naming:** `test_{action}_{scenario}` — e.g. `test_create_board_success`,
  `test_create_board_nonexistent_workspace`.
- **Backend integration tests** use `httpx.AsyncClient` against the real FastAPI
  app with in-process SQLite (aiosqlite). No Docker needed.
- **Auth in tests:** set the `X-User-Email` header to simulate a user.
- **Independence:** function-scoped DB sessions that roll back. No test may
  depend on another's leftovers.
- **Fixtures** live in `conftest.py`: `client`, `db_session`, `create_user`,
  `create_workspace`, `create_board`.
- Mark tests slower than ~500ms with `@pytest.mark.slow`.
- SQLite strips timezones — compare datetime *components*, not tz-aware objects.

## Architecture rules

These are not stylistic preferences; violations get rejected.

**Backend layering: Router → Service → Repository → Model. Never skip a layer.**

- **Routers** are thin: parse the request, call a service, return a schema.
- **Services** own business logic *and* authorization.
- **Repositories** are pure data access — no business logic.
- Record mutations via `ActivityService`.

**Other invariants**

- **Idempotent mutations.** Create/add operations that agents may retry must be
  idempotent: if the entity exists, return it (200/201) rather than erroring
  (409). LLMs retry, and multiple pipeline stages may hit the same endpoint.
- **Don't commit in services or repositories.** The `get_db` dependency commits
  on success and rolls back on exception. Use `flush()` to get generated IDs, and
  `refresh()` after `flush()` when `onupdate` columns are involved.
- **`selectinload` for nested schemas.** Any repository method whose Pydantic
  schema includes nested relationships must eager-load them.
- **Migration safety.** Migrations run on container startup with rolling
  deploys, so old and new code briefly share a schema: add columns as
  `nullable=True` or with a `server_default`; never rename (add, migrate, drop);
  removing a column takes two deploys.

**Frontend**

- Feature modules under `src/features/{name}/` with `api/`, `components/`,
  `hooks/`, `utils/`.
- **All** server state through React Query. Query keys live in
  `src/lib/query-keys.ts` — never inline them.
- All user-facing strings through `useTranslation()`; add equivalent keys to
  every locale in `frontend/src/i18n/supported-languages.ts` (currently `en`,
  `es`, and `pt-BR`).
- Tailwind v4, CSS-first config — there is no `tailwind.config` file.
- UI primitives in `src/components/ui/` are hand-written, not CLI-generated.

## Code style: the code is the documentation

- **Semantic naming over comments** — `retryable_count`, not `n`.
- **Comment the non-obvious only**: regex intent, concurrency traps, domain
  gotchas, magic thresholds, and *why* a surprising line exists.
- **Never comment the obvious.** No `# return the result`. No docstrings that
  restate the function name.
- When improving clarity, rename variables and extract named constants — don't
  restructure working code as a drive-by.

Run the linters before pushing from the repository root:
`cd backend && ruff check app/`, `cd frontend && pnpm lint`, and
`cd runner && go vet ./...`.

### Running every gate locally

```bash
make verify                 # everything CI runs, in one command
make verify JOB=frontend    # one job: backend | mcp | frontend | go | secrets
```

`scripts/verify-all.sh` mirrors `.github/workflows/ci.yml` job for job, so you
can get a definitive answer without waiting on (or depending on) GitHub Actions.
If you add a gate to one, add it to the other — they are meant to stay in
lockstep. Every job runs even when an earlier one fails, so a single red gate
doesn't hide the rest.

Two things worth knowing: `pnpm build` is the **only** typecheck (vitest does
not typecheck), and the backend suite must run from `backend/` because pydantic
reads the `.env` at the current directory.

## Pull requests (maintainers)

External PRs are closed unreviewed — see the top of this file. For team PRs:

- Keep them focused. One concern per PR.
- Explain **why**, not just what. Link the issue.
- CI must be green: backend pytest + ruff, MCP pytest, frontend lint + vitest +
  build, `go vet` + Go tests, and a secrets scan.
- **Never commit secrets.** `scripts/scan-secrets.sh` runs in CI and blocks the
  merge. Run it locally if you've touched configs or docs. Real credentials in
  example files are a hard no — use `${VAR}` placeholders.

## Reporting security issues

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
