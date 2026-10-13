# Beacon hook fixtures

`beacon_hooks.json` derives from synthetic native hook input executed by the
companion through the pinned Beacon executable at source commit
`b17031414618cf86f7aad2b485935e548e8a8e63` (Darwin arm64 SHA-256
`9a1807cc9aa3a2f4ef74ef7177796aea26644de012d35b89387674a7acec4924`).

The sequence covers start, prompt, MCP pre/post, failed Write, Stop, and end.
Host/user/path attributes use deterministic synthetic replacements. Event
actions, native IDs, content, provenance and timestamps retain the executable
output's structure. No live agent transcripts are included.

The file keeps the first companion's record envelope; tests use only each
record's `beacon_events` and wrap them in the current ingest record shape.
