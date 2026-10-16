# Changelog

Every public change to Backplane, newest first. Components use independent
version lines:

| Component | What it is | Current release | Get it |
| --- | --- | --- | --- |
| **Platform** | The web app, API and database you self-host | [0.1.4-preview.3](#platform-v0.1.4-preview.3) | [Source archive](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.4-preview.3) |
| **Runner** | Optional CLI that drives your own coding agent through board work | [0.8.8](#v0.8.8) | [Binaries](https://github.com/Valaris-Studio/backplane/releases/tag/v0.8.8) · `ghcr.io/valaris-studio/backplane-runner:0.8.8` |
| **MCP server** | Connects any MCP client to your boards | [0.9.4](#mcp-server-v0.9.4) | [`backplane-mcp` on PyPI](https://pypi.org/project/backplane-mcp/) |
| **Companion desktop** | Local session capture and desktop controls | [0.1.1-preview.2](companion/README.md#macos-desktop-preview) | [Signed macOS installer](https://storage.googleapis.com/backplane-artifacts/companion-desktop/v0.1.1-preview.2/Backplane-Companion-0.1.1-preview.2-universal.dmg) |

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

#### Added

- Inspect the captured calls supporting a linked card or note, separately for
  changed and consulted work. Each call explains whether its relationship was
  matched exactly or by timing, with explicit earlier-history loading.
- Refresh session evidence deliberately and continue to captured content for
  a reviewed handoff without losing the selected excerpt or pending note save.

#### Changed

- Session pages explain how to connect Companion when capture is unavailable,
  including when older sessions fall outside the selected period.
- Evidence counts describe loaded calls; filtered timelines no longer imply
  that omitted activity was idle time. Updated copy is available in English,
  Spanish and Brazilian Portuguese.

#### Fixed

- Failed session-history checks remain distinct from an empty capture history.
- Linked work opens in its authorized workspace. Unavailable targets hide
  retained titles and links, and losing session access cancels private reads
  and removes cached evidence.

---

<a id="platform-v0.1.4-preview.3"></a>

## Platform 0.1.4-preview.3 — 2026-10-16

`platform` `preview` · [Source archive](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.4-preview.3)

#### Changed

- Session pages put captured content before secondary diagnostics and keep
  excerpt review and selection counts within reach while reading.
- Navigate directly to loaded transcript items without changing the selected
  excerpt. The reader distinguishes loaded content from items still to load.
- Reviewed notes show their destination and audience beside the save action,
  preserve the reviewed request when a save response is lost, and link to the
  confirmed note and optional card after saving.
- Execution receipts explain the selected context before the full prompt.
  Historical invocation selection and exact retained prompt copying stay intact.
- Updated reader and handoff copy is available in English, Spanish and
  Brazilian Portuguese.

#### Fixed

- Reviewed handoffs survive compact-section changes, resizing and temporary
  session refresh failures. Losing access to the session removes its private
  preview and captured-content cache.
- A save that finishes while its dialog is hidden can be dismissed, allowing
  another excerpt to be prepared.

#### Upgrade notes

- This frontend update introduces no API changes or database migrations.
  Existing capture settings and source-access rules remain in effect; sharing
  a reviewed note does not grant access to the owner's private session.
- Runner 0.8.8, MCP server 0.9.4 and Companion 0.1.1-preview.2 retain their
  independent versions. This platform release does not republish those clients.
- Navigation covers loaded captured items, not a complete session analysis.
  Existing preview capture, privacy and upgrade limitations still apply.

---

<a id="mcp-server-v0.9.4"></a>

## MCP server 0.9.4 — 2026-10-15

`mcp` · [Package](https://pypi.org/project/backplane-mcp/0.9.4/)

#### Security

- Require MCP SDK `>=1.30.0,<2` to address CVE-2026-59951: stateful Streamable
  HTTP sessions now have finite idle and capacity limits and release ended or
  refused sessions. Stdio is outside this advisory.

#### Upgrade notes

- Upgrade the independent MCP package to 0.9.4 and restart the server/connection;
  credentials, toolsets, allowlists and the tool catalog stay compatible.
- MCP launched from an older platform source archive needs the 0.9.4 package
  or `mcp-server-v0.9.4` source. Existing platform archives retain their original
  MCP lockfiles; platform, runner and Companion releases are unchanged.

---

<a id="platform-v0.1.4-preview.2"></a>

## Platform 0.1.4-preview.2 — 2026-10-15

`platform` `preview` · [Source archive](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.4-preview.2)

> Keep runner installation and upgrade guidance aligned across distribution channels.

#### Changed

- Setup downloads and documentation now target runner 0.8.8 with MCP 0.9.3 in
  English, Spanish and Brazilian Portuguese.
- Release notes distinguish GitHub archive checksums from raw native-binary
  checksums and describe the default container's coding-agent selection.

#### Upgrade notes

- Runtime behavior and migrations are unchanged from 0.1.4-preview.1. Its
  privacy, capture and upgrade limits still apply.
- Upgrade the platform before enabling runner required-context policies or
  budgets. Inventory and drain incompatible runners, and keep a compatible
  rollback runtime; an update does not enable a policy.
- Companion installers and completion-manifest v2 activation remain separate
  from this platform release.

---

<a id="v0.8.8"></a>

## Runner 0.8.8 — 2026-10-15

`runner` `experimental` · [Binaries](https://github.com/Valaris-Studio/backplane/releases/tag/v0.8.8)

> Publish the prepared-context runner through the corrected release workflow.

#### Fixed

- Restore annotated runner tags in the disposable release checkout before
  building archives and container images. Remote release tags remain immutable.

#### Changed

- Clarify the separate GitHub archive and raw native-binary checksum channels.
  The default container build selects Claude Code; Codex CLI is an explicit
  custom-build option.

#### Upgrade notes

- Runner behavior is unchanged from 0.8.7, including MCP 0.9.3, required-context
  preparation and context budgets. Published 0.8.7 raw binaries remain available
  without replacement; use 0.8.8 for the coordinated distribution channels.
- Pair with platform 0.1.4-preview.2. Inventory and drain incompatible runners
  before enabling required-context policies or budgets, and retain a compatible
  rollback runtime. Installing the binary does not activate a policy.
- Completion-manifest v2 activation is not part of this release.

---

<a id="platform-v0.1.4-preview.1"></a>

## Platform 0.1.4-preview.1 — 2026-10-15

`platform` `preview` · [Source archive](https://github.com/Valaris-Studio/backplane/releases/tag/platform-v0.1.4-preview.1)

> Read captured sessions privately, review selected evidence before sharing it,
> and inspect the context supplied to your coding agents.

#### Added

- Durable, authenticated media and resource content links keep note images and
  attachments readable after signed storage URLs expire.
- Documentation reads can select one anchored section, including a single MCP
  tool entry.
- Companion daemon and desktop source for scoped coding-session capture, with
  per-device controls, retention and private session readers.
- Session readers support bounded excerpts and an explicit handoff to card
  notes. Sharing an excerpt does not make the raw session public.
- Runner source can prepare mandatory context through the backend, record the
  dispatched input and acknowledge it before calling an agent. Optional context
  budgets bound configured inputs while preserving required context.

#### Changed

- Session and card views provide clearer capture status, reading and handoff
  controls across the registered interface languages.
- Frontend asset retention keeps up to five retired releases for seven days
  and supports history baked into replacement images. Mounted-volume retention
  is detected automatically, excluding memory-backed tmpfs; set
  `RETAIN_ASSETS_TO_VOLUME` explicitly to enable or disable it.

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
- Session content remains owner-private; excerpt handoff checks access to the
  destination card. Context preparation, acknowledgement and replay recheck
  current authorization.

#### Upgrade notes

- Upgrade the platform before using runner 0.8.7 and MCP 0.9.3. Runners 0.8.5 and 0.8.6
  do not implement the required-context protocol; keep policies in legacy
  mode until every participating runner and the rollback runtime are compatible.
- Companion source is included. Desktop installers and automatic updates are
  separate distributions; this platform archive does not install Companion.
- Companion and rich capture remain disabled by default. Enable them deliberately
  and configure device scope, capture level and retention before collecting data.
- The source backend applies migrations through 122 even when these features are
  disabled. Back up and qualify upgrades from the installed version before use.
  Schema compatibility alone does not qualify an older runtime for rollback:
  keep context policies in legacy mode with no budgets until all workers and
  runners, including the rollback runtime, support the enabled policies.
- MCP 0.9.3 adds provenance-bearing, retry-safe excerpt-note creation and
  requires this platform API. Existing MCP 0.9.2 installations continue to
  support ordinary notes without the new excerpt parameters.

---

<a id="v0.8.7"></a>

## Runner 0.8.7 — 2026-10-15

`runner` · [Raw binary checksums](https://storage.googleapis.com/backplane-artifacts/runner/v0.8.7/SHA256SUMS)

> **Distribution status:** Raw macOS, Linux and Windows binaries were published.
> GitHub archive and container publication stopped at an annotated-tag checkout
> conflict. The immutable tag and raw binaries are preserved; 0.8.8 fixes the
> release workflow for the coordinated channels.

> Dispatch the authorized context prepared by your platform, with explicit
> receipts and bounded inputs.

#### Added

- Prepare and acknowledge backend-selected mandatory context before invoking
  the configured coding agent. Missing or stale required context fails before
  the provider runs.
- Support configured context budgets and preserve required context within the
  backend's authorization and freshness contract.

#### Fixed

- Harden resumed coding-agent launches and artifact readiness checks against
  the supported CLI contract.

#### Security

- Update the Go toolchain and networking dependencies used by release binaries.

#### Upgrade notes

- Upgrade to platform 0.1.4-preview.1 before enabling required-context policies.
  Inventory and drain incompatible runners and keep a compatible rollback
  runtime before activation. Installing the binary does not activate a policy.
- Completion-manifest v2 activation is not part of this release.
- Raw native binaries cover macOS, Linux and Windows on arm64 and amd64.
  GitHub archives and the GHCR image were not published for this version.

---

<a id="mcp-server-v0.9.3"></a>

## MCP server 0.9.3 — 2026-10-15

`mcp-server` · [PyPI](https://pypi.org/project/backplane-mcp/0.9.3/)

> Save a reviewed session excerpt with its provenance and a stable retry key.

#### Added

- `create_note` accepts `client_request_id` and `excerpt_source` for a
  board-scoped reviewed excerpt. The backend verifies source ownership,
  destination access and freshness; an identical retry returns the original
  note. Recipients receive the saved note, not access to its private source.

#### Upgrade notes

- Excerpt saves require a backend with `/notes/from-excerpt`. An older backend
  returns an error rather than silently creating a note without retry safety.
  Ordinary `create_note` calls are unchanged.
- Preserve credentials, custom toolsets and allowlists. Restart the MCP
  server/connection to refresh the tool schema. This MCP release does not deploy
  the platform, upgrade the runner or publish a Companion installer.

[Full MCP notes](mcp-server/CHANGELOG.md#093---2026-10-15)

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

<a id="v0.8.6"></a>

## Runner 0.8.6 — 2026-10-05

`runner` · [Raw binary checksums](https://storage.googleapis.com/backplane-artifacts/runner/v0.8.6/SHA256SUMS)

#### Changed

- Published checksummed macOS, Linux and Windows binaries for arm64 and amd64.
  This version was distributed through the artifact bucket; it has no GitHub
  runner release.
- Generated MCP configurations select `backplane-mcp==0.9.1`.

#### Upgrade notes

- This version predates required-context preparation and context budgets.
  Upgrade to runner 0.8.7 with a compatible platform before enabling those
  policies. Existing versioned binaries and checksums remain unchanged.

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
