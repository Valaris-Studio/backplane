# Backplane companion

A per-machine background app (macOS, Linux, Windows) that captures your
coding-agent sessions and uploads them to Backplane, where they become private
sessions linked to Backplane work. Claude Code, Pi and Codex (CLI and
Desktop) are supported; the agent interface (`internal/agent`) is where
further adapters plug in.

**Source preview.** This tree provides buildable source; it does not announce a
signed installer or updater release. The backend's `COMPANION_ENABLED` and
`RICH_CAPTURE_ENABLED` flags default to `false`. Enable the services deliberately
and choose the device scope, capture level and retention before collecting data.
Captured sessions are private to their owner. Sharing a selected excerpt with a
card is an explicit action and does not share the raw session.

The desktop source is in [`desktop/`](desktop/). Its package builders stage the
Companion, pinned Beacon binaries and license notices together:
[`build_desktop.py`](scripts/build_desktop.py) for macOS (ad hoc signing by
default), [`build_desktop_linux.py`](scripts/build_desktop_linux.py) and
[`build_desktop_windows.py`](scripts/build_desktop_windows.py) for unsigned
Linux and Windows packages. Each builder documents its toolchain and options;
building only the web frontend does not produce an installed desktop app.

One `connect` registers the machine as a single Backplane installation. Agent
hooks are installed once at the user level. For every session the companion
decides, before retaining anything, whether it is in scope.

## How it works

```
agent hook ──> backplane-companion hook <agent>    (shim: scope check, sanitize, one inbox file, prints {})
                        │
                        ▼
              private inbox ──> backplane-companion run   (daemon)
                                   ├─ refresh policy every 5 min
                                   ├─ re-check scope, resolve git-remote auto-matches
                                   ├─ normalize with the pinned beacon-hooks
                                   ├─ durable queue (ack persisted before delete)
                                   └─ upload to /api/companion/ingest
```

The shim never runs Beacon or uses the network and always answers `{}` with
exit 0; failures are counted in `health.json`. Nothing is captured until the
device is connected and holds a cached policy.

### Capture scope

Decided per session from the canonical working directory, in this order:

1. **Exclusions**: local pause, server pause, revoked device, policy older
   than 24 h, agent not enabled, exclude globs, locally ignored paths, the home
   directory, `/`, temp directories.
2. **Explicit mapping**: the longest mapped root containing the directory. A
   disabled mapping excludes.
3. **Auto-match** (when enabled): the repository's `origin` remote, read from git
   config without running git and normalized to lowercase `host/owner/repo`, matched
   against the repos bound to boards you can access. The daemon asks the server
   to create the mapping.
4. Otherwise **unmapped**: nothing is retained; the repository root and remote
   are listed as a discovered project.

Each mapping has a content level. It decides what leaves the device; the
server applies the same rules again and never stores more.

- `metadata` sends activity only: counts, timing, tokens and cost; agent,
  model, tool, MCP server and MCP tool names; the repository URL and branch;
  the working directory's base name (not its path); command exit codes and
  durations; file operation and language. Prompts, messages, commands, tool
  arguments and output become a size and hash. Sessions have no title.
- `standard` (default) adds prompts, commands and tool arguments, including
  file paths relative to the project, each bounded at 4 KiB, plus error
  messages. The first prompt becomes the session title. Tool output (Claude
  `tool_response`, Pi tool results, Codex `codex.tool_result`,
  `stdout`/`stderr`) becomes `{bytes, sha256}`, and the agent's replies, raw
  payloads and file diffs are not stored. A command is sent but the file
  content it carries is not: a heredoc or `echo`/`printf` body that writes a
  file or feeds a patch tool or a file-writing script, a unified diff and an
  apply_patch envelope each become a size and hash, for every agent.
- `full` adds tool output (up to 16 KiB per field, with a truncation marker),
  the agent's replies where the harness reports them, file diffs and the file
  content commands carry. Beacon's Claude mapper does not carry tool output
  into its events, so Claude uploads contain none at any level.

At every level the device strips the account and host name and
`transcript_path`, rewrites local paths (relative to the project root, `~/…`
under the home directory), masks secret-looking text heuristically, and never
retains embedded binary.

## Use

Requires Go 1.26+. Build the pinned Beacon artifact once (Python 3.12+); it
downloads the exact archive in `beacon-source.json`, verifies it, builds
`beacon-hooks` without patches and writes `artifact.json` with its checksum and
license notices. No compiled executable belongs in git.

```sh
python3 scripts/build_beacon.py --output /tmp/beacon-artifact
python3 scripts/build_beacon_otelcol.py --output /tmp/beacon-artifact   # for Codex
go build -o /tmp/backplane-companion ./cmd/backplane-companion

# Exchange an API key for a device token kept in the OS keyring.
# The key is read from BACKPLANE_API_KEY or a no-echo prompt and never stored.
/tmp/backplane-companion connect --endpoint https://backplane.example.com

/tmp/backplane-companion agents install        # agents present on this machine
BACKPLANE_BEACON_ARTIFACT=/tmp/beacon-artifact/artifact.json \
  /tmp/backplane-companion service install      # start `run` at login, now too
```

`service install|uninstall|start|stop|status` registers the daemon per user:
a launchd agent (`~/Library/LaunchAgents/dev.backplane.companion.plist`) on
macOS, a systemd user unit (`~/.config/systemd/user/backplane-companion.service`)
on Linux, and a logon Scheduled Task (`\Backplane\Companion`) on Windows. A
Windows service is not used because it could not read the user's Credential
Manager. Each definition restarts the daemon only after a failure and carries
`BACKPLANE_COMPANION_HOME` and `BACKPLANE_BEACON_ARTIFACT` from the installing
shell. The daemon writes `logs/companion.log` in the data directory, capped at
5 MiB plus one rotated file. `run` does not exit while it waits for a
connection or for a Beacon artifact that is missing or being upgraded, and a
second `run` exits cleanly. Uninstall and stop touch only definitions marked
as the companion's. The daemon re-checks owned agent hooks at start and every
30 minutes and repoints stale ones (for example after the companion moved). It
never re-adds a hook you removed; `agents install` restores those.

The daemon sends a heartbeat (`POST /api/companion/status`) at start, when an
agent's capture state changes and every 5 minutes, never more than once a
minute: the companion version, the Beacon commit, each agent's state
(`capturing`, `not_installed`, `disabled` or `error` with problem codes) and
queue health (pending, dropped total, oldest pending). It carries no local
path. When the owner deletes a session on the server, its history up to the
deletion is gone, not the session: ingest names the session in
`history_deleted` with a cutoff on the device's clock, and acknowledges records
holding nothing after it as `dropped` (`session_deleted`). The companion
deletes those, counts them per reason, and stops uploading what it observed by
the cutoff; activity after it, such as a resumed session, is captured as a
fresh session, and its desktop row says the earlier history was deleted (or,
for `retention`, removed). What the agent itself carries into the resumed
session with new timestamps, such as a compaction or resume summary, or
earlier turns a harness re-emits on resume, is new content after the cutoff
and is captured like any other.
`status` shows the
server's session retention (`capture.retention_days`), read-only.

When the server answers a device call (policy, ingest, heartbeat or mapping)
with 401 and the backend's `invalid_device_token` code, the device was
revoked: the daemon logs `device_revoked`, stops uploading, deletes the token
from the keyring and waits; `status` shows `revoked`. A bare 401 (e.g. from a
proxy) is only retried with backoff. `connect` then enrolls again without a
`disconnect` first; a revoked installation id is replaced by a new one. The
queue survives a reconnect only when the same installation is restored (its
token rotated); connecting as a new installation, or to another endpoint,
first deletes the queue, inbox, Beacon work files, upload ledger, threads and
cached policy, so nothing captured under one installation uploads under
another.

Other commands:

| Command | Purpose |
| --- | --- |
| `status [--human]` | Connection (`revoked` when the server refused the credential), service, capture state, per-agent state (`broken`, `not_installed`, `not_configured`, `revoked`, `not_connected`, `paused`, `uploading`, `receiving`, `idle`), queue and inbox health, projects waiting for a decision |
| `agents list\|install\|uninstall\|status [agent]` | Manage only companion-owned hook entries; foreign hooks and unknown settings are preserved |
| `projects list` | Mappings, discovered and ignored projects |
| `projects map PATH` | Map a repository through server auto-match |
| `projects ignore PATH` | Never capture sessions under PATH |
| `pause` / `resume` | Local capture switch, effective immediately |
| `disconnect` | Revoke the device on the server (best effort; `server_revoked` is also true when the server had already revoked it), delete the token, and remove every captured, derived and log file (see *Removing the companion*). A running daemon ends its capture session first and then waits for the next `connect`, so the service need not be stopped |

Data lives in `~/Library/Application Support/Backplane Companion` (macOS),
`${XDG_STATE_HOME:-~/.local/state}/backplane-companion` (Linux) or
`%LOCALAPPDATA%\Backplane\Companion` (Windows); override with
`BACKPLANE_COMPANION_HOME`. `run` looks for `beacon/artifact.json` next to the
executable unless `--beacon-artifact` or `BACKPLANE_BEACON_ARTIFACT` is set.
Errors print a stable code followed by an English, Spanish or Portuguese
message chosen from `LC_ALL`/`LC_MESSAGES`/`LANG`.

On Windows, each data directory has its own control pipe under the current
user's SID. When upgrading from a build with a SID-only pipe, stop the old
daemon before replacing the bundle, then start the updated daemon. For an
installed service, use `backplane-companion service stop` before the upgrade
and `backplane-companion service start` afterwards. Update Desktop and the
daemon together: updated clients refuse the old endpoint and report the
daemon as unavailable until it restarts. They never fall back to a SID-only
pipe belonging to another data directory.

### Removing the companion

```sh
backplane-companion disconnect          # revoke, delete the token and the data
backplane-companion agents uninstall    # remove the companion's hooks only
backplane-companion service uninstall   # stop the daemon, remove the definition and logs
```

Any order works (`service uninstall` first is fine too). Afterwards the data
directory holds only files with no content and no path: the lock files, the
OTLP gate port (`otel.json`) and, if capture was paused, `preferences.json`
with just the pause, so a later `connect` does not silently resume capture.
Everything else is removed: the installation, policy and admission state, the
inbox, queue and Beacon work files, discovered projects, threads, suppressed
sessions, health, the `otel/` runtime files, ignored paths and the logs (a
running daemon's open logs are emptied by `disconnect` and removed by
`service uninstall`). Delete the directory itself to remove those too.

## Bundles

`scripts/build_bundle.py` builds one installable bundle per release target
(darwin/arm64, darwin/amd64, linux/amd64, linux/arm64, windows/amd64) from this
checkout and the pinned Beacon archive:

```sh
python3 scripts/build_bundle.py --output dist --version 0.1.0 \
  [--target host|goos/goarch ...] [--beacon-archive beacon.tar.gz] [--no-archive]
```

```
backplane-companion-<version>-<goos>-<goarch>/
  backplane-companion[.exe]      CLI, hook command and (off Windows) the daemon
  backplane-companiond.exe       Windows only: the same program, GUI subsystem
  beacon/beacon-hooks[.exe]      pinned Beacon hook normalizer
  beacon/artifact.json           its checksum manifest, verified before each run
  beacon/beacon-otelcol[.exe]    pinned Beacon collector (Codex telemetry)
  beacon/otelcol.json
  LICENSES/                      every license and notice file shipped
  THIRD_PARTY_NOTICES.txt        every linked Go module with its license text
  manifest.json                  versions, commits, checksums, licenses
  SHA256SUMS                     `sha256sum -c` over every other file
```

plus a `.tar.gz` (a `.zip` for Windows) of that directory. Every binary is
built with CGO disabled, `-trimpath`, no VCS stamp and an empty build id,
so the same checkout, Beacon archive and Go toolchain give byte-identical
bundles. The companion's version and commit are stamped with `-ldflags -X`;
the Beacon commit is compiled in, and the build fails if it disagrees with
`beacon-source.json`. The collector is generated with the OpenTelemetry
Collector Builder and compiled by the script with the same flags. Nothing is
signed or notarized unless you ask for it (below).

The build reads each binary's module list with `go version -m` and the license
files from the module cache, and identifies them with
`github.com/google/licensecheck` (`scripts/licensecheck/`, build-time only).
It fails closed: a license file passes only if recognized licenses cover at
least 80% of it, every one of them is MIT, BSD-2-Clause, BSD-3-Clause,
Apache-2.0, ISC or MPL-2.0, and the rest of the text names no restrictive
terms (GPL family, BUSL, SSPL, Commons Clause, "Good, not Evil", Elastic,
non-commercial). A module with several licenses is recorded as an SPDX
expression such as `MIT AND Apache-2.0`; MPL-2.0 modules are listed under
`license_flags` in `manifest.json`. It also
fails if Beacon's self-updater module (`cli/beacon`) is linked into any
bundled binary; `beacon-hooks` and `beacon-otelcol` have no update path, and
Beacon runs with a private HOME and a minimal environment.

On Windows the logon task starts `backplane-companiond.exe` when it is present,
so no console window opens, while `backplane-companion.exe` stays a normal
console program for the CLI and agent hooks: hooks always point at it, even
when the windowless daemon installs or repairs them. Beacon and the collector are
started without a console window.

`version` prints the build and whether the Beacon artifacts next to the
executable verify; `status` shows the CLI's version and the running daemon's
(`health.daemon`), which differ after an upgrade until the daemon restarts.
These are the inputs an updater needs; the companion does not update itself.

### Signing macOS releases

Unsigned darwin binaries are killed by Gatekeeper when they come from a
download (they carry the quarantine attribute). A release build signs and
notarizes them on a Mac with the Developer ID identity in the login keychain:

```sh
# DEVELOPER_ID_APP   "Developer ID Application: NAME (TEAMID)", or its SHA-1
# AC_API_KEY_ID, AC_API_ISSUER, AC_API_KEY_P8 (base64 of the .p8, may be
#                    line-wrapped): an App Store Connect API key, for notarytool
python3 scripts/build_bundle.py --output dist --version 0.1.0 --sign-macos
```

`--sign-macos` is opt-in and fails when a variable is missing or the identity
is not a Developer ID Application identity in the keychain; it never falls
back to an unsigned build. Only the darwin targets are signed (from either Mac
architecture); other targets build as usual. `--skip-notarize` signs without
notarizing, for a local test.

Only the `.p8` is secret. It is written to a private temporary file for
notarytool and deleted afterwards (also on SIGTERM), and it is redacted from
every error. The key id and issuer are identifiers: they are passed on
notarytool's command line, so other local users can see them with `ps` while
the submission waits (up to an hour). The build removes all three variables
from its environment once it has read them, so no other child process (go,
the collector builder, codesign) inherits them.

Once a darwin target's three binaries (`backplane-companion`,
`beacon/beacon-hooks`, `beacon/beacon-otelcol`) are built, they are signed with
the hardened runtime and a secure timestamp, before anything reads them, so
`artifact.json`, `otelcol.json`, `manifest.json` and `SHA256SUMS` all record
the signed bytes (the companion refuses Beacon binaries whose hash differs).
The signed binaries are then submitted to Apple's notary service as one zip,
and the build waits for the verdict; a rejection fails the build with the
notary log, and no archive of that bundle is left in the output directory.
Last, every binary must pass `codesign --verify --strict`,
`codesign --verify --check-notarization --test-requirement==notarized` (the
flag alone also accepts an unnotarized binary) and
`spctl --assess --type install`, which must report a notarized Developer ID
(`--type execute` only assesses app bundles, and rejects any command-line
tool). The build prints the submission id, and a darwin bundle's
`manifest.json` records it under `macos_signing`
(`{"signed": true, "notarization": {"id": ..., "status": "Accepted"}}`;
`"signed": false` for an unsigned build).

A bare executable cannot be stapled, so the ticket is not in the bundle:
Gatekeeper looks it up online the first time a quarantined binary runs, so
that first run needs to reach Apple; offline it can be refused. Shipping the
darwin bundles as a signed, stapled `.pkg` would remove that dependence; it is
not built today.

The secure timestamp differs on every signing, so signed bundles are not
byte-identical between runs. The reproducibility claim above is about the
unsigned build: to check it, build without `--sign-macos` and compare. The
checksums in a signed bundle are computed after signing. The signature
names the certificate's holder, which anyone can read with `codesign -dv`.

## Test

Run the Go tests from a copy outside the repository, never from this
checkout: the tests build throwaway repositories, and the companion walks up
from a folder to the nearest `.git`, which inside a checkout is the real one.

```sh
# From companion/: includes the sibling contracts/ corpus and refuses Git ancestors.
../scripts/companion-source-gate.sh go
# Full source/build-contract checks, including packaging and the desktop frontend:
make -C .. verify JOB=companion
# macOS only; pinned Rust library and permission/configuration contracts:
make -C .. verify JOB=companion-rust
```

The shared gate documents its pinned Go, Node and pnpm toolchains and its
Python/macOS prerequisites in [CONTRIBUTING.md](../CONTRIBUTING.md#running-every-gate-locally).
Its Go JSON reports include every skipped test; absent Beacon integration is
not a privacy qualification. The normal gate uses the production keyring build
and also vets `devkeyring` and tests its CLI/credential packages.

The bundle scripts have their own tests; the host bundle build runs only
when asked, since it takes minutes:

```sh
python3 -m unittest discover -s scripts/tests
BACKPLANE_BUNDLE_TEST=1 python3 -m unittest discover -s scripts/tests
```

Tests use temporary HOMEs, `BACKPLANE_COMPANION_HOME`, an in-process fake
server (`internal/uplinktest`) and the keyring mock; they never touch your real
agent settings, keychain or transcripts. Without `BACKPLANE_BEACON_ARTIFACT` the
tests that run the real `beacon-hooks` are skipped.

## Agents

- **Claude Code**: user-level hooks in `$CLAUDE_CONFIG_DIR/settings.json`
  (default `~/.claude/settings.json`) that run `backplane-companion hook
  claude-code`. Other hooks and settings are preserved. On Windows Claude Code
  runs hooks through Git Bash, so the path is single-quoted as on POSIX.
  Its hooks carry no token usage, so at SessionStart, Stop and SessionEnd the
  daemon (never the hook) reads the lines the session's transcript and its
  subagent transcripts added since the last read, decoding only each
  response's ids, model, token counts, service tier and speed; message
  content is never kept. Each response becomes one `token.usage` event whose
  id is derived from its message and request ids, so a re-read counts once.
  Usage uploads only from spans the daemon saw capture allowed for the
  session's mapping and directory, and not from before the session's first
  hook.
- **Pi**: one managed extension, `extensions/backplane-companion.ts` under
  `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`), that forwards Pi's seven
  observed events to `backplane-companion hook pi` without waiting for it
  (only `session_shutdown` is awaited, for at most 2 s). It only observes and
  coexists with Beacon's own `beacon.ts`. Pi exposes no operator approval
  decisions, so none are recorded. Restart Pi after installing.

- **Codex**: owned command hooks in `$CODEX_HOME/hooks.json` (default
  `~/.codex`) for SessionStart, SubagentStart, UserPromptSubmit and
  PreToolUse record each thread's working directory; they carry no telemetry.
  On Windows Codex runs hooks through PowerShell, so they are written as
  `& "<path>" hook codex`. A `hooks.json` Codex would reject (it then ignores
  every hook in it) is never written and is reported as `invalid_config`.
  A marked block in `config.toml` points Codex's log and trace exporters at
  the companion's loopback OTLP gate (`otel.json` in the data directory holds
  its port). The gate forwards a thread's records only once its scope is
  decided, drops out-of-scope threads, and holds undecided ones in memory for
  at most 30 s. In-scope records are normalized by the pinned
  `beacon-otelcol` (built by `build_beacon_otelcol.py`, found through
  `--otelcol-artifact`, `BACKPLANE_OTELCOL_ARTIFACT` or `beacon/otelcol.json`
  next to the executable). Codex runs hooks only after the user trusts them
  ("Hooks need review" → "Trust all and continue", or `/hooks`); the
  companion reports `needs_trust` and never approves them itself. Codex
  appends its own tables (project trust, hook `trusted_hash`, `[tui]`) after
  the block and moves its END marker below them, so uninstall and repair
  remove only the block's own lines and refuse an edit that would change any
  other setting. An existing
  OpenTelemetry exporter in `config.toml` is left alone and reported as
  `conflict_existing_otel`.

### Using Pi with the Backplane MCP server

Pi has no built-in MCP client. Use
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
(`pi install npm:pi-mcp-adapter`) and add the Backplane MCP server to its
config. Every tool shape it offers works: direct tools, the `mcp` proxy tool
and `mcp__<server>` tools.

Backplane links a captured session to the cards and notes its MCP calls
touched in one of two ways:

- **Exact.** The MCP server reads the harness's own id for the tool call
  from the request `_meta`: `claudecode/toolUseId` for Claude Code, `callId`
  for Codex and `pi-mcp-adapter/toolCallId` for Pi. It links the call to the
  one captured session with that id.
- **Correlated.** Pi's MCP extensions don't send the id yet. Forwarding it
  has been proposed upstream to pi-mcp-adapter. Until that lands, the server
  links a Pi call to the one captured Pi tool call of the same user that
  matches on all of these:
  - the same tool;
  - the same arguments, compared on the content-level digest, so this works
    at every content level;
  - a time within 10 seconds.

Correlated links show as `provenance: correlated`. Correlation links nothing
in these cases:

- the tool call is already claimed by an exact id;
- there are two candidate tool calls;
- another identical invocation competes for the same tool call;
- the companion rewrote the arguments (home paths, redacted secrets or
  truncated text);
- more than 10 seconds passed between Pi's tool call and the MCP request, for
  example on a cold MCP server start or while a consent prompt waited.

These all fail safe: no link rather than a wrong one. The window compares
the companion's clock with the MCP server's. With a local (stdio) server they
are the same clock. With a remote (HTTP) server, device clock skew beyond a
few seconds means Pi calls don't correlate; exact ids don't depend on clocks.

An exact invocation on the same card or note makes the link `exact`. Pi's
OpenAI call ids (`<call id>|<item id>`, often 400+ characters) are accepted;
the MCP server and backend both store ids over 200 characters as
`sha256:<hex>` of the id, so the two sides still match.

## Known limits

- Beacon's Claude `Stop` mapping records completion, not the assistant reply.
  Claude transcripts are opened only by the daemon, for token usage.
- Claude usage from while the daemon was not running is never counted:
  nothing observed whether capture was allowed then. A crash loses at most
  the last minute before it the same way.
- A Claude response still streaming at a `Stop` waits for the next boundary;
  the tail of a session that crashed before its last `Stop` is read at its
  next `SessionStart` with the same session id, or never.
- The pinned Claude mapper emits `file.modified` for a failed edit, so the
  companion omits edit input and output for `PostToolUseFailure`.
- The companion removes the `user` and `endpoint.hostname` members Beacon adds
  to every event; sessions are attributed through the device credential.
- Windows relies on the default user-private ACL of `%LOCALAPPDATA%`; native
  Windows and Linux runs, service installation and signing are not yet qualified.

## Licensing and updating

The companion is MIT-licensed (`LICENSE`), like the runner. Beacon and
`pkg/asymptoteobserve` keep their own MIT notice (`third_party/beacon-LICENSE`).
Updating Beacon means updating `beacon-source.json`, the Go module revision and
`beacon.Commit` together, rebuilding the artifact and rerunning the real
executable tests. A local artifact manifest is build provenance, not a signed
release.
