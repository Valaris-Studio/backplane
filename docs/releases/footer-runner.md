## Install or upgrade

GitHub release archives cover macOS and Linux on amd64 and arm64; verify them with [checksums.txt](https://github.com/Valaris-Studio/backplane/releases/download/{tag}/checksums.txt). Raw binaries also cover Windows on both architectures; their separate checksum file is [SHA256SUMS](https://storage.googleapis.com/backplane-artifacts/runner/v{version}/SHA256SUMS).

The default Linux amd64/arm64 container build selects Claude Code. To include Codex CLI, build with `CODING_AGENTS="claude codex"`. Authenticate the providers you configure before running work.

Upgrade the platform before the runner. See the [runner guide](../../runner/README.md) for configuration. Runners remain experimental.
