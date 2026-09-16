# API Surfaces

Backplane serves one flat OpenAPI document at `/api/openapi.json` (Swagger UI
at `/api/docs` in development). Not every route in it makes the same promise:
some are the CRUD an adopter should build on, some are the Go runner's wire
protocol, some exist only because the console needs them.

> **Live schema versus repository snapshot:** the running backend is the source
> of truth. `docs/api/openapi.json` is a checked-in snapshot for offline use and
> may lag the live schema until `python scripts/export-openapi.py` is run in the
> backend environment. Do not infer a missing field or `x-surface` value from a
> stale snapshot without checking `/api/openapi.json` on the target release.

Every operation therefore carries an `x-surface` vendor extension whose value
is one of `public`, `internal`, or `runner`. It is an extension rather than a
tag so that generated clients and adopters can filter on it while Swagger's
existing tag grouping stays exactly as it was.

```console
$ curl -s localhost:8000/api/openapi.json \
  | jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[]
           | select(.value["x-surface"] == "public")
           | "\(.key|ascii_upcase) \($p)"'
```

The classification lives in one place — `backend/app/core/api_surfaces.py` —
and is stamped onto the schema by `_stamp_api_surfaces` in
`backend/app/main.py`. No router carries surface metadata.

## The three surfaces

| Surface | What it is | Stability promise |
| --- | --- | --- |
| `public` | Workspace/board/card/note/resource/channel/team/prompt-config CRUD (the endpoints the MCP tools wrap), plus loop template authoring (`/loop-templates`, board-scoped fit/preview, and `/loop/binding` reads), versioned product documentation reads (`/api/documentation`), auth basics, `/api/me`, and health probes. | **Stable.** Breaking changes to request or response shape are avoided; when unavoidable they are called out in release notes. Build integrations on this surface. |
| `internal` | Console and operations contracts: metrics, alerts, notifications, loop control (`PUT /loop`, `PATCH /loop/state`, readiness, history, transitions), config bundle import/export, cost breaker, OAuth/OIDC redirect flows, media and local-storage transfer, sensors, role labels, lifecycle kinds, execution history reads. | **No promise.** Shapes change whenever the console needs them to, without notice or a deprecation window. |
| `runner` | The Go runner's wire protocol: identity and config bundle, heartbeat, poll, next-assignment, execution create/patch/warnings/tool-invocations, and the worker-side merge-queue enqueue. | **Versioned with the runner binary, not independently.** Backend and runner ship together; treat any mismatch as a version-skew bug, not an API to code against. |

A route being `public` does not imply an MCP tool exists for it. Convenience
REST-only reads — board `timeline` and `history`, `resources/tags`, the
`definitions`/`notes`/`teams`/`prompt-configs` `export` endpoints,
`git-connections`, and `boards/{board_id}/context` — are classified `public`
because adopters legitimately depend on them, but they are read/export
conveniences with no MCP wrapper.

## Method-level splits

Surface is resolved per `(method, path)`, so one prefix can serve two
audiences:

- `POST /api/agents/{agent_id}/executions` is `runner` (the runner mints an
  execution); `GET` on the same path is `public` (an operator lists them).
- `POST /api/workspaces/{slug}/merge-queue/enqueue` and `.../re-enqueue` are
  `runner`; the queue reads and `POST .../{entry_id}/cancel` are `public`
  operator actions.
- `/api/workspaces/{slug}/boards/{board_id}/loop/binding` (and `.../binding/diff`)
  are `public` template-authoring reads carved out of the otherwise `internal`
  `/loop` subtree, which keeps `PUT /loop`, `PATCH /loop/state`, `readiness`,
  `history`, and `transitions`.

## Promotions

**2026-08-17 — loop templates, `internal` → `public`.** The loop template
manager (`/api/workspaces/{slug}/loop-templates*`, the board-scoped
`/loop-templates/{ref}/fit|fit/apply|preview` routes, and the `/loop/binding`
reads) shipped with a complete MCP twin surface, so it now carries the same
stability promise as the rest of the MCP-parity CRUD. Loop *control* was
deliberately left `internal`: enabling a loop, patching its state, and reading
its readiness are console operations whose shapes still move. Design of record:
spec note `f52328b3` §6.2 (REST/MCP parity) and §6.3 (docs & stability).

## Adding a route

`backend/tests/test_api_surfaces.py::test_every_route_is_classified` fails for
any `/api/` route that resolves to no surface. Add an entry to `_RULES` in
`app/core/api_surfaces.py` — rules match by path prefix, longest first, with an
optional method, so a single endpoint can be carved out of a broader subtree.
The test failing is the point: a new route should inherit a stability promise
somebody decided to make, not whichever one its neighbours happen to have.
