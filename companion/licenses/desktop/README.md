# Desktop dependency license texts

Some published Rust crates omit their workspace's license files. `catalog.json`
binds checked-in replacements to the exact crate name, version, declared license
and `.cargo_vcs_info.json` commit. The desktop builder verifies each file's SHA256
and uses these files only when the package contains no license file. Unknown
packages, changed source identities and missing or altered texts fail the build.
No license is downloaded during a build, and this catalog does not change the
allowed license expressions.

The `sources` URLs record the origin of each exact file. Workspace packages share
the same text. Most files come directly from the crate's upstream commit. The
objc2 packages retain their current licensing declaration together with the full
MIT license from the parent of the upstream licensing-clarification commit, an
ancestor of all recorded crate commits. Its original copyright is preserved.
Selectors' complete MPL 2.0 text comes from Mozilla, as referenced by its source
header; `selectors-SOURCE.txt` supplies the exact unmodified source locations.

When a dependency version changes, review its actual package and upstream license
again before adding a new exact catalog entry. Keep declarations and source
availability notices separate from the complete license text they accompany.
