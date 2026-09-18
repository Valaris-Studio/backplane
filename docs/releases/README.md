# Release artifacts

Backplane versions its distributions independently:

| Distribution | Tag | Artifacts |
| --- | --- | --- |
| Platform | `platform-v<VERSION>` | Source archive, `release.json`, `SHA256SUMS` |
| Runner | `v<version>` | Native binaries, checksums, GHCR image |
| MCP server | `mcp-server-v<version>` | PyPI wheel and source distribution |

The root `VERSION` identifies the platform distribution. Package metadata inside the monorepo describes individual packages and need not share that version. A platform release does not automatically republish runner or MCP packages.

Platform bundles contain the exact tracked source at a public commit. The manifest records that commit, its tree, and the archive's SHA-256. Production Compose builds the frontend and backend from this source. No prebuilt platform container images are implied by the source release.

To prepare an archive from a clean public checkout, using Python 3.12 or later:

```sh
python3 scripts/platform-release.py package --tag "platform-v$(cat VERSION)" --output /tmp/backplane-release
cd /tmp/backplane-release
sha256sum --check SHA256SUMS
```

On macOS, use `shasum -a 256 -c SHA256SUMS`. Packaging excludes untracked files and does not create a tag, publish a release, or claim that tests passed. Keep qualification results for the exact commit separately.

Release tags must identify commits already included in public `main`. Platform tag workflows run CI and the fresh-clone Quickstart before packaging. A permitted publication creates a draft GitHub release for review; maintainers publish that draft separately.

Publishing requires the repository variable `PUBLIC_RELEASES_ENABLED=true` and a configured environment: `platform-release`, `runner-release`, or `pypi`. Before enabling publication, maintainers must configure required reviewers, restrict each environment to its component's tags, protect release tags from replacement/deletion, and align PyPI's trusted publisher with the `pypi` environment. Merely naming an environment in YAML does not configure its protections. See [GitHub's environment setup](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and [PyPI trusted publishing setup](https://docs.pypi.org/trusted-publishers/adding-a-publisher/).

Tags and published package versions are immutable release identities. Fixes ship as new versions; do not replace an existing version's artifacts. Reverting an application version must also account for database migration compatibility and backups.
