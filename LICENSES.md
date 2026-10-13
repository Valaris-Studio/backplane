# Licensing

Backplane is a monorepo with **per-component licenses**. This file is the map;
each license's full text lives in the file named below.

| Component | Path | License | Full text |
|---|---|---|---|
| Platform core — backend, frontend, MCP server | `backend/`, `frontend/`, `mcp-server/` | **AGPL-3.0-or-later** | [`LICENSE`](LICENSE) |
| The autonomous runner | `runner/` | **MIT** | [`runner/LICENSE`](runner/LICENSE) |
| The companion | `companion/` | **MIT** | [`companion/LICENSE`](companion/LICENSE) |
| Rich-capture contract (wire examples, native-source fixtures) | `contracts/rich-capture/` | **AGPL-3.0-or-later** (repository default, for now) | [`LICENSE`](LICENSE) |
| API / OpenAPI / MCP tool schemas | see note below | **Apache-2.0** | [`LICENSE-APACHE`](LICENSE-APACHE) |

The repository's default license is **AGPL-3.0-or-later** (`LICENSE`). A file is
under a different license only if a `LICENSE` file in its own directory says so,
or if it falls under the schema carve-out described below.

## Why this split

The pattern follows GitLab / GitLab Runner:

- **AGPL for the core.** If you run a modified Backplane as a network service,
  the AGPL requires you to offer your modifications to its users. This protects
  the project from being re-hosted as a closed competing service while keeping
  it genuinely open source (OSI-approved) for self-hosters, who are free to run,
  modify, and redistribute it.
- **MIT for the runner and the companion.** The runner executes on operator
  machines and is embedded into other people's toolchains and CI; the companion
  runs on user and operator machines next to their coding agents, and its
  builds ship with the MIT-licensed Beacon (see "Companion and Beacon" below).
  Permissive licensing removes every friction from
  that integration; there is no re-hosting risk in a process that pulls work
  from a board or captures sessions on its own machine.
- **Apache-2.0 for the interface schemas.** Integrations must be able to
  implement against our API and MCP tool surface without inheriting a copyleft
  obligation. Apache-2.0 also grants an explicit patent license, which is the
  norm for interface specifications.

### Schema carve-out — precise scope

The Apache-2.0 grant covers the **interface definitions only**, so that any
client, SDK, or integration may be built against them under any license:

- The generated OpenAPI document describing the REST API.
- The MCP tool and prompt **schemas** — the tool names, descriptions, and
  input/output JSON Schemas as exposed over the MCP protocol.

It does **not** cover the *implementation* of those interfaces. The FastAPI
routers, services, and repositories that serve the API, and the `mcp-server/`
Python package that implements the tools, are AGPL-3.0-or-later like the rest of
the core.

### `contracts/rich-capture/`

The rich-capture contract has no `LICENSE` file of its own and is not part of
the Apache-2.0 schema carve-out above, so for now it is under the repository
default, **AGPL-3.0-or-later**. The MIT companion's tests read it as test data;
that does not change the license of either.

## Companion and Beacon

The companion **source** in `companion/` is MIT and vendors no Beacon code. Its
Go build depends on Beacon's `pkg/asymptoteobserve` module (pinned in
`companion/go.mod`), and its bundle builders fetch and verify the Beacon
archive pinned in `companion/beacon-source.json`. Beacon's MIT license text is
kept at [`companion/third_party/beacon-LICENSE`](companion/third_party/beacon-LICENSE).

**Built** companion bundles and desktop apps carry their own notices
(`LICENSES/`, including Beacon's MIT text, and `THIRD_PARTY_NOTICES.txt`),
generated at build time; see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md#companion-and-beacon).

## Contributing

Backplane is not accepting outside code contributions at this stage — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). These licenses still govern what you may do
with the code, including forking it.

## Third-party dependencies

See [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md). It documents one
deliberate non-OSI dependency (GSAP) and how to build without it.
