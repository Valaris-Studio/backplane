# Changelog

Every public change to Backplane, newest first. The repository ships three
components on independent version lines:

| Component | What it is | Current release | Get it |
| --- | --- | --- | --- |
| **Platform** | The web app, API and database you self-host | [0.1.3-preview.1](#platform-v0.1.3-preview.1) | [Source archive](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.3-preview.1) |
| **Runner** | Optional CLI that drives your own coding agent through board work | [0.8.5](#v0.8.5) | [Binaries](https://github.com/Valaris-Studio/backplane/releases/tag/v0.8.5) · `ghcr.io/valaris-studio/backplane-runner:0.8.5` |
| **MCP server** | Connects any MCP client to your boards | [0.9.2](#mcp-server-v0.9.2) | [`backplane-mcp` on PyPI](https://pypi.org/project/backplane-mcp/) |

A platform release never republishes the runner or MCP server; each entry
says which versions it was qualified with. Upgrade the platform before the
runner. Backplane coordinates the agents you bring; it ships no model or
intelligence of its own.

**Preview releases.** Versions with a `-preview.N` suffix are pre-releases:
installable and tested, but interfaces and data formats may still change
between previews. Each preview entry lists its known limitations. Runners are
experimental.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
grouped as Added, Changed, Fixed, Security and Removed. The MCP server also
keeps its own detailed per-tool history in
[`mcp-server/CHANGELOG.md`](mcp-server/CHANGELOG.md).

---

<a id="unreleased"></a>

## Unreleased

Changes in the source tree that are not yet part of a published platform release.

#### Added

- Durable, authenticated media and resource content links keep note images and
  attachments readable after signed storage URLs expire.
- Documentation reads can select one anchored section, including a single MCP
  tool entry.

#### Fixed

- Markdown note reads and writes preserve supported formatting, images and
  attachments. Card responses consistently include their column labels.
- Board context summaries bound repeated status text to keep project briefings
  compact.

#### Security

- Media reads enforce workspace, board and resource permissions. Resource
  registration verifies that the uploaded object exists.
- Local storage responses and rich text handling reject unsafe media and link
  URLs, including approval text and payloads.

---

<a id="mcp-server-v0.9.2"></a>

## MCP server 0.9.2 — 2026-10-07

`mcp-server` · [PyPI](https://pypi.org/project/backplane-mcp/0.9.2/)

> Agents can attach files in one call, and the tool list loads lighter.

#### Added

- `upload_resource` uploads a file and registers it as a resource in one
  call, so an agent can attach a screenshot or a report to a note without a
  shell. It takes a local `path` (only when the server runs over stdio, up to
  25 MiB, never a secret-looking file such as `.env` or an SSH key) or the
  bytes as `content_base64` (up to 5 MiB), and returns `content_url` plus a
  ready-to-paste `embed_markdown` line.

#### Changed

- Tool descriptions state each tool's contract, and the usage notes they
  carried moved to the tool's entry in the in-app MCP reference. A
  description ending in "See docs." has more there. The tool list a client
  loads shrinks from about 110 KB to 96 KB; no existing tool or parameter
  changes.
- `get_project_context` keeps its reply under 32,000 characters. Over that,
  it trims the biggest sections first and says what it cut in `_size_capped`
  and `_hint`. The platform's board summary also keeps only each column's 8
  most common card statuses and counts the rest as `_other`, so a board whose
  agents write progress logs into card status no longer floods the briefing.
- `get_download_url` and `create_resource` (for an uploaded file) return
  `content_url`, a stable link to embed in notes that keeps working after
  the signed `download_url` expires. `create_resource` reads the file's type
  and size from the stored object, and registering before the upload fails
  with 422 `object_not_uploaded` and a hint to upload first.

#### Fixed

- `update_note.anchor_heading` again says heading matching is trimmed as well
  as case-insensitive.

#### Upgrade notes

- Reading one tool's entry (`read_documentation` with
  `slug="mcp-tool-catalog#tool-<name>"`) needs a platform release with
  anchored documentation reads. Older platforms answer 404 for such a slug and
  still serve the whole section.
- `content_url` needs a platform release with durable media links; older
  platforms return none from `get_download_url` and serve no `/content`
  route.

[Full MCP notes](mcp-server/CHANGELOG.md#092---2026-10-07)

---

<a id="mcp-server-v0.9.1"></a>

## MCP server 0.9.1 — 2026-10-05

`mcp-server` · [PyPI](https://pypi.org/project/backplane-mcp/0.9.1/)

> Note writes answer briefly, and text that looks like JSON stays text.

#### Changed

- `create_note` and `update_note` receipts no longer echo the note body. They
  report `content_chars`, the stored body's size, instead. Pass
  `return_content=True` to get the stored content back as before.

#### Fixed

- Optional text parameters, such as `update_note.content` and
  `update_card.description`, keep JSON-looking text as text instead of
  rejecting it with "Input should be a valid string".
- Card responses include `column_name` and `column_type` on every path, not
  only from `search_cards`. This needs a platform release that includes the
  matching backend change; older platforms still return `null` outside search.

[Full MCP notes](mcp-server/CHANGELOG.md#091---2026-10-05)

---

<a id="platform-v0.1.3-preview.1"></a>

## Platform 0.1.3-preview.1 — 2026-10-05

`platform` `preview` · Qualified with runner 0.8.5 and MCP server 0.9.0 · No database migrations

> Fewer blank pages after upgrades, notifications that take you somewhere,
> and the MCP server 0.9.0 source.

#### Added

- The card detail panel lists the notes linked to the card and shows its
  branch name.
- Binding a loop template tells you when the board's done gate will be
  relaxed for a self-merge loop. Re-rendering a template never relaxes it.
- CI checks that the diagram renderer stays out of eagerly loaded frontend
  bundles.
- The repository now carries the MCP server [0.8.1](#mcp-server-v0.8.1) and
  [0.9.0](#mcp-server-v0.9.0) source.

#### Fixed

- Mention notifications show their target and link to it, and linked notes
  reopen from their deep link.
- Frontend deployments keep previously built assets, so pages that were open
  during an upgrade no longer go blank, and failed page loads recover.
- Spanish translations have their accents and diacritics back.

#### Security

- DOMPurify is updated to 3.4.16 for a low-severity sanitizer advisory.

#### Known limitations

- The in-app guides keep 15 screenshot placeholders. Their descriptions
  explain the intended views; they are not captured screenshots.

**Upgrade:** back up the database and uploaded files, then follow
[Self-hosting](https://github.com/Valaris-Studio/backplane/blob/platform-v0.1.3-preview.1/README.md#self-hosting).

[Release](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.3-preview.1) ·
[Compare with 0.1.2-preview.2](https://github.com/Valaris-Studio/backplane/compare/platform-v0.1.2-preview.2...platform-v0.1.3-preview.1) ·
[#8](https://github.com/Valaris-Studio/backplane/pull/8),
[#9](https://github.com/Valaris-Studio/backplane/pull/9),
[#11](https://github.com/Valaris-Studio/backplane/pull/11)

---

<a id="mcp-server-v0.9.0"></a>

## MCP server 0.9.0 — 2026-10-04

`mcp-server` · [PyPI](https://pypi.org/project/backplane-mcp/0.9.0/) · Source public since platform 0.1.3-preview.1

> Tool calls are recorded without ever slowing a response down, and Intel
> Macs can install the server again.

#### Changed

- Each tool call is recorded as one private invocation outcome owned by the
  calling key, posted from a bounded background queue so a response never
  waits on the backend. A platform without the endpoint only loses the
  records, never a tool call. `get_server_info` reports the counts under
  `invocation_tracking`.
- Outcomes carry agent-neutral context from the MCP client (`harness`,
  `native_call_id`, `client_name`, `client_version`, `server_instance_id`),
  so a call can be matched with your coding agent's own record of it.
- The deprecated aliases from 0.7.0 remain callable; their removal moves to
  0.10.0.

#### Fixed

- Installs on Intel macOS work again: that platform is held on a
  `cryptography` release that still ships a prebuilt wheel.

#### Security

- Outcomes for `get_download_url`, `get_upload_url`, `create_agent` and
  `rotate_agent_key` keep no result summary, because signed URLs and new API
  keys are credentials. All recorded summaries redact signed-URL query values.
- Locked dependencies include PyJWT 2.15.1 and urllib3 2.8.0.

[Full MCP notes](mcp-server/CHANGELOG.md#090---2026-10-04)

---

<a id="mcp-server-v0.8.1"></a>

## MCP server 0.8.1 — 2026-09-30

`mcp-server` · [PyPI](https://pypi.org/project/backplane-mcp/0.8.1/) · Source public since platform 0.1.3-preview.1

#### Added

- An optional default board from `VALARIS_DEFAULT_WORKSPACE_SLUG`,
  `VALARIS_DEFAULT_BOARD_ID` and `VALARIS_DEFAULT_BOARD_NAME`. Tools fill a
  missing workspace or board argument from it; an explicit argument always
  wins. With none of them set, nothing changes.

#### Fixed

- `create_workspace` refuses a malformed slug before sending any request, and
  asks for an explicit slug when none can be derived from the name instead of
  falling back to a shared one.

[Full MCP notes](mcp-server/CHANGELOG.md#081---2026-09-30)

---

<a id="platform-v0.1.2-preview.2"></a>

## Platform 0.1.2-preview.2 — 2026-09-21

`platform` `preview` · Qualified with runner 0.8.5 and MCP server 0.8.0 · Database migration 108

> Skills keep an auditable history, and failed completion reviews can
> recover instead of stalling.

#### Added

- Skill revisions keep their source identity and audit history across edits
  and approvals. Authorized callers can read revision history through the API.
- A failed completion review can send the work back for one bounded round of
  source rework instead of leaving it stalled. Requires runner 0.8.5.

#### Changed

- Runner download guidance and supported coding-agent guidance (Claude Code,
  Codex CLI) are corrected in English, Spanish and Portuguese.
- Public examples use generic repository names and local paths.

#### Security

- OpenTelemetry dependencies are updated to 1.45.0.

#### Known limitations

- The in-app guides keep 15 screenshot placeholders, described in all three
  languages.

**Upgrade:** back up the database and uploaded files. Migration 108 runs
automatically at startup. Upgrade the platform before the runner.

[Release](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.2-preview.2) ·
[Compare with 0.1.1-preview.1](https://github.com/Valaris-Studio/backplane/compare/platform-v0.1.1-preview.1...platform-v0.1.2-preview.2) ·
[#5](https://github.com/Valaris-Studio/backplane/pull/5),
[#6](https://github.com/Valaris-Studio/backplane/pull/6),
[#7](https://github.com/Valaris-Studio/backplane/pull/7)

<a id="platform-v0.1.2-preview.1"></a>

> **`platform-v0.1.2-preview.1` was tagged but never published.** Its release
> workflow was cancelled before packaging; 0.1.2-preview.2 is the release.

---

<a id="v0.8.5"></a>

## Runner 0.8.5 — 2026-09-21

`runner` `experimental` · Pairs with platform 0.1.2-preview.2 and MCP server 0.8.0

> Failed completion reviews get one bounded correction attempt.

#### Added

- With a compatible platform, a failed independent completion review can hand
  one correction attempt to the configured source agent, with the failed card,
  the candidate and the review finding in its context. Existing iteration,
  timeout and budget limits still apply.
- Recovery logs name the candidate, the failure finding and the recovery
  action. The runner finds recovery work across paginated results.

#### Changed

- Failed candidates stay unaccepted and dependent work stays blocked.
  Corrected evidence needs a fresh review, changed source needs a new
  candidate, and unresolved attempts return to you for inspection instead of
  repeating the same review.

#### Security

- OpenTelemetry and related dependencies are updated.

**Get it:** native binaries for macOS, Linux and Windows on amd64 and arm64
(verify with `SHA256SUMS`), or the Linux container
`ghcr.io/valaris-studio/backplane-runner:0.8.5`, which includes Claude Code and
Codex CLI. Authenticate the providers you configure before running work.

[Release](https://github.com/Valaris-Studio/backplane/releases/tag/v0.8.5) ·
[Runner guide](runner/README.md)

---

<a id="platform-v0.1.1-preview.1"></a>

## Platform 0.1.1-preview.1 — 2026-09-18

`platform` `preview` · Qualified with runner 0.8.4 and MCP server 0.8.0

> The first tagged platform release: a smoother first install and better
> mobile navigation.

#### Added

- Platform releases ship as a reproducible source archive with a
  `release.json` manifest and `SHA256SUMS`, tagged `platform-v*` and versioned
  independently from the runner and MCP server.

#### Fixed

- A failed attachment upload no longer leaves a successful-looking attachment
  behind, and the reverse proxy accepts uploads up to the documented limit.
- PostgreSQL passwords containing URL-reserved characters work without manual
  encoding.
- Database transactions finish before a successful API response is sent.
- Cold restore instructions wait for PostgreSQL to be ready and name the
  correct storage volume.
- Mobile navigation keeps account controls reachable and groups utility
  actions into an accessible menu.
- Workspace navigation stays on the current origin, and override validation
  is fixed.
- Office document previews are hardened, and Linux setup validation works
  again.

#### Security

- Dependency updates address reported security advisories.

[Release](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.1-preview.1) ·
[Compare with the public launch](https://github.com/Valaris-Studio/backplane/compare/fb4d7ad5...platform-v0.1.1-preview.1) ·
[#4](https://github.com/Valaris-Studio/backplane/pull/4)

---

<a id="public-launch"></a>

## Public source launch — 2026-09-16

Backplane's source opened under its [licenses](LICENSES.md). At launch the
current releases were runner 0.8.4 and MCP server
[0.8.0](mcp-server/CHANGELOG.md#080---2026-09-15); earlier MCP history is in
[`mcp-server/CHANGELOG.md`](mcp-server/CHANGELOG.md).

Backplane is developed by the Valaris team and does not accept outside pull
requests; bug reports and feature requests are welcome in
[Issues](https://github.com/Valaris-Studio/backplane/issues). See
[CONTRIBUTING.md](CONTRIBUTING.md).
