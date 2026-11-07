# Backplane companion

A per-machine background app (macOS, Linux, Windows) that captures your
coding-agent sessions and uploads them to Backplane, where they become private
sessions linked to Backplane work. Claude Code, Pi and Codex (CLI and
Desktop) are supported; the agent interface (`internal/agent`) is where
further adapters plug in.

**macOS desktop preview 0.1.1-preview.3 is available below.** Linux and Windows
desktop packages remain source builds. The backend's `COMPANION_ENABLED` and
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

## macOS desktop preview

[Download Backplane Companion 0.1.1-preview.3](https://storage.googleapis.com/backplane-artifacts/companion-desktop/v0.1.1-preview.3/Backplane-Companion-0.1.1-preview.3-universal.dmg)
for macOS 13 or later, on Apple silicon or Intel. The universal app and DMG are
Developer ID signed and notarized. This preview includes the latest capture
compatibility fixes and retains the existing updater verification key.

For a new installation, open the DMG, move **Backplane Companion** into
**Applications**, then open it and follow the connection and capture setup.
Choose the project scope, capture levels and retention deliberately.

For an existing installation:

1. Choose **Quit Backplane Companion** from its menu-bar menu. Stop its existing
   background service before replacing the application:

   ```sh
   "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion" service stop
   "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion" service status
   ```

   Confirm that the status reports `"daemon_running": false` before replacing
   the app. Stopping sends a shutdown request; if it still reports `true`, wait
   and repeat `service status` until shutdown finishes.

   For the one-time transition from an ad hoc or source-built app to this signed
   preview, also unload the stopped service registration:

   ```sh
   launchctl bootout "gui/$(id -u)/dev.backplane.companion"
   ```

   This preserves the service definition and data while letting macOS register
   the signed executable after replacement.

2. Open the downloaded DMG and replace **Backplane Companion** in **Applications**.
3. If you unloaded the registration in step 1, load the same service definition:

   ```sh
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.backplane.companion.plist"
   ```

   Otherwise, start the existing service:

   ```sh
   "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion" service start
   ```

   Check its status:

   ```sh
   "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion" service status
   ```

   Confirm `"daemon_running": true`, repeating the status check if startup is
   still in progress. Then open the updated app:

   ```sh
   open "/Applications/Backplane Companion.app"
   ```

Keep the existing connection, mappings and capture settings. Disconnecting or
removing the companion is a different operation and can delete captured data.

When upgrading from an older ad hoc or source-built app, install the signed
preview manually to establish the current updater key. It is published on the
**beta** channel; installation does not change your chosen channel. Select beta
in update settings if you want future beta updates.
The stable channel is separate. The [versioned update manifest](https://storage.googleapis.com/backplane-artifacts/companion-desktop/v0.1.1-preview.3/latest.json)
identifies the signed universal update archive for both Mac architectures.

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

For a new binding, the desktop preselects Rich when the server offers it and
Standard otherwise. Review the choice before confirming. An app update does
not raise an existing mapping's capture level.

- `metadata` sends activity only: counts, timing, tokens and cost; agent,
  model, tool, MCP server and MCP tool names; the repository URL and branch;
  the working directory's base name (not its path); command exit codes and
  durations; file operation and language. Prompts, messages, commands, tool
  arguments and output become a size and hash. Sessions have no title.
- `standard` adds prompts, commands and tool arguments, including
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
  into its events; Rich can capture that content separately from native session
  files.
- `rich`, where offered by the server, keeps Full's event behavior and adds
  messages, tool output and supported attachments from native session files.
  These content bodies can extend beyond Full's 16 KiB event-field limit.
  Capture requires an authorized Rich mapping and still follows project scope,
  server-offered size limits, local storage limits and retention. Unsupported
  or oversized attachments are withheld. URLs in content are not fetched.

For events at every level, the device strips the account and host name and
`transcript_path`, rewrites local paths (relative to the project root, `~/…`
under the home directory), masks secret-looking text heuristically, and
replaces embedded binary with metadata. Rich content uses separate text and
attachment checks; supported embedded attachments can be retained within the
limits above.

## Use

Requires Go 1.26+; the Beacon and release builds refuse a toolchain older than
go1.26.9. Build the pinned Beacon artifact once (Python 3.12+); it downloads the
exact archive in `beacon-source.json`, verifies it, builds `beacon-hooks`
without patches and writes `artifact.json` with its checksum and license
notices. `beacon-otelcol` is generated from the unmodified `builder.yaml`, then
its module is lifted to the dependency floors declared in
`build_beacon_otelcol.py`; `otelcol.json` records them as linked under
`generated_module_overrides`. No compiled executable belongs in git.

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

### Headless (operator-managed)

On a Unix host without a keyring, run `backplane-companion run
--headless-config /abs/config.json`. The config names the one identity the
data directory captures for, and only the operator may change it. It must be
a regular file owned by root or the companion's user, writable by no one
else, in a directory under the same rules. Unknown fields are refused:

```json
{"endpoint": "https://backplane.example.com",
 "token_file": "/run/backplane-companion/token/device-token",
 "installation_id": "<installation uuid>", "owner_email": "owner@example.com"}
```

`endpoint` is the API origin, with no path. Optional fields are
`token_uid`/`token_gid` (default: the companion's user and group) and
`allow_loopback_http` (loopback test servers only). The token file must lie
outside the data directory (`token_file_in_data_root` otherwise). It holds
exactly one device token with at most one trailing newline. It has mode 0400
or 0600 and a single link, and no symlink appears on its path. Every
directory above it is owned by root or `token_uid` and writable by no one
else unless sticky. Replace it by renaming a new file over the path; in a
container, mount its directory, not the file. The token is never written,
logged or reported.

Before any capture, each session checks the token with `GET
/api/companion/me`. Until that matches the config, capture holds and keeps
the queue; `status` shows why under `headless`. A changed token file ends the
session within about 2 s. A token file the server rejected is not sent again,
across restarts too, until the file changes. Editing the config to another
identity moves the old state to `quarantine/<binding_id>/`, and switching
back restores it. A switch also needs the new identity's token file: until it
replaces the one verified for the current binding, the switch holds as
`token_not_replaced_for_switch` and nothing is sent. The Companion tells files
apart by their metadata (device, inode, size, times, mode, owner), not their
bytes, so touching or re-provisioning the old token counts as a replacement:
install the new identity's token before restarting. Anything but an empty
directory in a switch's way holds it as `switch_blocked`, named in
`blocked_by`; it is never merged or removed, and the switch finishes once the
operator moves it out of the data directory. On SIGTERM the daemon uploads
what is queued for at most 8 s.

A coding agent that runs as another user cannot run `hook` against a 0700
data directory. For that topology the config names a hook socket and the
one uid it serves:

```json
{"hook_socket": "/run/backplane-companion/hook/hook.sock", "hook_peer_uid": 10000}
```

Both fields or neither. `hook_socket` is an absolute path in a directory
owned by the companion's user, mode 0711, writable by no one else and not a
symlink (`unsafe_hook_directory` otherwise, refused at start); the socket
itself is 0666 so the peer can connect, and the peer check is the boundary.
`hook_peer_uid` is never 0 and never the companion's own uid. The daemon
serves the socket only while a verified binding captures: it is absent
before verification, during a hold, a switch or a rejection, and during the
stop drain, so no record is retained for another binding. Each connection
carries one record, `<agent-id>\n<payload>`, half-closed by the client, at
most 64 KiB of payload, within 5 s; the daemon answers `{}` once the record
went through the same shim as `hook <agent>`, and closes without an answer
when it refuses the frame (counted in `health.json` as
`hook_payload_too_large`, `hook_agent_not_served`, `hook_invalid_framing` or
`hook_read_timeout`). A connection from any other uid, or one that cannot be
identified, is closed without a reply or a count, as is any connection past
64 held open at once. A connection that sends nothing is a liveness probe;
it proves a listener answers at the path, not which Companion or for which
uid, which the worker's runtime qualification establishes. Only agents
whose records arrive through an in-agent plugin (Hermes, Pi) are served;
the others run the shim themselves. The shim writes what `hook <agent>`
writes: the inbox, the health counters and, for an out-of-scope repository,
its root and remote in `discovered.json`; never the payload.
The Hermes plugin dials the socket when `BACKPLANE_COMPANION_HOOK_SOCKET`
names it in the gateway's environment. Because the shim canonicalizes each
record's working directory on this filesystem, the companion container must
mount the worker's repository read-only at the same path the worker sees it.
Windows has no headless mode, so there the field is refused with
`unsupported_platform` like the rest of the config.

In a bound data directory, `connect`, `disconnect`, `mcp`, `uninstall`,
`rename`, `pause`, `resume`, `projects map|ignore|unignore`, `agents
install|uninstall` and every control API request other than `GET` answer
`headless_operator_managed`, as session reads do. The device token can act
for its owner beyond capture, so protect it like an owner API key. The
companion ignores HTTP proxies, so restricting its egress is the operator's
network responsibility.

`headless/` packages this mode as a container. Build it with `companion/` as
the context; both base images are pinned by digest, and the build fetches Go
modules and the pinned Beacon archive:

```sh
docker build --platform linux/amd64 -f headless/Dockerfile \
  --build-arg COMPANION_VERSION=0.1.0 --build-arg COMPANION_COMMIT="$(git rev-parse HEAD)" \
  -t backplane-companion-headless:0.1.0 .
```

The image has no shell. It runs `run --headless-config
/etc/backplane-companion/config.json` as UID and GID 10001. Its executables
are root-owned and read-only, and its data root is `/var/lib/backplane-companion`.
It ships `beacon-hooks` but not the OTLP collector, so it captures no Codex
telemetry.

`headless/compose.example.yaml` is the hardened service: a read-only root,
every capability dropped, `no-new-privileges`, a named volume for the data
root, the token's directory and the config mounted read-only, no ports, and a
20 s stop grace period for the 8 s drain. It does not restrict egress.
`headless/qualification/qualify.py` re-runs the container qualification
against fake servers, with no network.

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

  Codex Desktop's `create_thread` can inject the initial instruction as a
  delegated tool result instead of exporting a user-prompt event. The companion
  reads that instruction from the matching thread's confined rollout, with a
  stable event id so restart does not duplicate it. Only a startup whose first
  hook arrives within one minute of creation is eligible. The directory,
  mapping, capture windows, content level and redaction still apply; this
  fallback does not import other messages or old session history.

- **Hermes Agent**: an observer plugin that forwards `on_session_start`,
  `post_tool_call`, denied `post_approval_response` and `on_session_finalize`
  to `backplane-companion hook hermes`, at most once, from one background
  thread, with only `PATH`, `HOME` and `BACKPLANE_COMPANION_HOME` in its
  environment. It registers no hook that can block or rewrite what Hermes
  does. Only metadata is uploaded, at every content level: ids, tool and MCP
  names, status, the approval decision, the working folder and when Hermes
  observed the event. Duration, model and surface stay on the device;
  arguments, results, messages and approval commands are dropped, never
  digested.
  Sessions on messaging platforms are not captured. Set the plugin up by hand:
  copy `internal/agent/hermes/plugin/` to
  `$HERMES_HOME/plugins/backplane-companion/` (default `~/.hermes`), rename
  `__init__.py.tmpl` to `__init__.py`, replace `__COMPANION_ARGV__` with
  `["<absolute companion path>", "hook", "hermes"]`, then run
  `hermes plugins enable backplane-companion`. Capture also needs
  `hermes_agent` in the installation's `enabled_agents`, the owner's
  capture-policy setting (`PATCH /api/me/companion/installations/{id}/policy`);
  it is not on by default. The desktop app does not list or toggle Hermes, and
  saving its agent settings can drop `hermes_agent` (a known limitation).
  Turn outcomes and token usage are unknown, and MCP calls are not linked to
  cards or notes: Hermes sends MCP servers no tool-call id. Beacon records
  blocked or failed Hermes tool calls as ordinary tool events, and Backplane
  shows no outcome for them; in one-shot runs Hermes blocks a flagged command
  without asking, so no denied approval is recorded. A gateway session is
  recorded as ended when its last viewer detaches: Hermes finalizes it outside
  the session, so the plugin reports the surface and folder the session last
  showed, and drops the end of a session it never saw.

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
  The daemon reads transcript usage and content according to the mapped
  project's capture level and scope.
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
- Windows and Linux desktop distribution remains source-only. Native runtime
  tests do not establish a qualified desktop installer, GUI or signing.

## Licensing and updating

The companion is MIT-licensed (`LICENSE`), like the runner. Beacon and
`pkg/asymptoteobserve` keep their own MIT notice (`third_party/beacon-LICENSE`).
Updating Beacon means updating `beacon-source.json`, the Go module revision and
`beacon.Commit` together, rebuilding the artifact and rerunning the real
executable tests. A local artifact manifest is build provenance, not a signed
release.
