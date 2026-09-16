# Third-party licenses

Backplane's own licensing is described in [`LICENSES.md`](LICENSES.md). This file
covers **dependencies**, and in particular the one dependency that is *not*
OSI-approved.

Authoritative, machine-readable inventories are generated from the lockfiles
rather than maintained by hand:

```bash
# Frontend (pnpm)
cd frontend && pnpm licenses list

# Backend / MCP server (Python)
pip install pip-licenses && pip-licenses --format=markdown

# Runner (Go)
go install github.com/google/go-licenses@latest && go-licenses report ./runner/...
```

## ⚠ Non-OSI dependency: GSAP

| | |
|---|---|
| Package | `gsap` (frontend) |
| License | **GSAP Standard License** — <https://gsap.com/standard-license> |
| OSI-approved | **No** |
| Redistributable | Yes — free for all users under the Standard License |
| Terms last checked | 2026-09-04 against <https://gsap.com/pricing> and the license page (vendor marks the license "last modified 2025-05-30") |

**This is a deliberate, documented exception.** GSAP drives Backplane's motion
design, which is a substantive part of the product's feel, so it is not being
swapped out for a permissive alternative.

**Current terms (not legal advice — the official pages are authoritative):**
since Webflow acquired GSAP, GSAP is 100% free for all users, including
commercial projects and the plugins that used to be members-only. The Standard
License's only use-based exclusion is building a no-code visual animation tool
that competes with Webflow's animation builder; it also forbids
reverse-engineering GSAP into such a tool and removing GSAP's proprietary
notices. Backplane is a project-management platform, not such a tool.

**What this means for you:**

- **Self-hosting / evaluating Backplane:** nothing to do. The Standard
  License permits the use Backplane makes of it at no charge.
- **Corporate license scanners** frequently flag GSAP because it is not
  OSI-approved. That flag is expected and is not a licensing defect in
  Backplane. Review the GSAP Standard License against your own policy.
- **Redistributing a modified Backplane:** anyone running your derivative
  takes GSAP under the same Standard License directly from Webflow; keep
  GSAP's copyright notices intact. If its terms conflict with your policy,
  see "Building without GSAP" below.

### Building without GSAP

GSAP is not funnelled through one module. 14 non-test files import from `gsap`
directly: `frontend/src/lib/animations.ts` holds the shared presets, and 13
components and pages call GSAP themselves (Dashboard, BoardView, KanbanCard,
KanbanColumn, dialog, sheet, EmptyState, count-up, OnboardingRail,
ConnectAgentCallout, NoteList, NotificationBell, DwellBars).

Removing GSAP is therefore a migration across all of those files to the
MIT-licensed [`motion`](https://motion.dev) package (already a dependency),
not a one-file swap. Every animation already short-circuits under
`prefers-reduced-motion`, which gives a no-animation code path that the test
suite exercises, but it does not remove the import. The count above is pinned
by `backend/tests/test_third_party_licenses_gsap.py` against the tree, so it
cannot drift again.

## Everything else

All other dependencies are under standard permissive or weak-copyleft licenses
(MIT, BSD-2/3-Clause, Apache-2.0, ISC, PSF, MPL-2.0). Notable stacks:

| Area | Principal dependencies | Typical license |
|---|---|---|
| Backend | FastAPI, Starlette, SQLAlchemy, Alembic, Pydantic, asyncpg, uvicorn, gunicorn, httpx, cryptography, githubkit | MIT / BSD-3-Clause / Apache-2.0 |
| Google client libs | `google-auth`, `google-cloud-storage` | Apache-2.0 |
| Frontend | React, React Router, TanStack Query, Radix UI, dnd-kit, TipTap, XYFlow, Recharts, Tailwind CSS, lucide-react, i18next, axios, motion | MIT |
| Syntax / markdown | highlight.js, markdown-it, react-markdown, remark-gfm, mermaid | BSD-3-Clause / MIT |
| Runner (Go) | OpenTelemetry SDK + OTLP exporters, `gopkg.in/yaml.v3`, `nhooyr.io/websocket` | Apache-2.0 / MIT |

Run the generator commands above for exact, version-pinned results; treat this
table as orientation, not as a legal inventory.
