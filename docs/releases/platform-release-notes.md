# Backplane platform 0.1.2-preview.2

This preview adds immutable skill revision provenance and audit history, and includes the completion-review recovery fix published since the previous archive.

- Skill revisions retain their source identity and audit history across edits and approvals. Authorized callers can inspect revision history through the API.
- Failed completion reviews can return work to bounded source rework instead of leaving the original work stalled. Runner support is required for the new recovery path.
- Public examples use generic repository names and local paths.

The platform source bundle includes the production Compose configuration and installation documentation. Verify `SHA256SUMS` and unpack the archive. From inside the extracted directory, copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` and `OAUTH_STATE_SIGNING_KEY`, and run `docker compose -f docker-compose.prod.yml up -d`. Open `http://localhost:8080` to create the first administrator account.

Existing installations should back up their database and uploaded files before upgrading. Database migration 108 adds skill revision provenance and audit records and runs automatically at startup. Upgrade the backend before upgrading runners.

See [Self-hosting](../../README.md#self-hosting) for configuration and troubleshooting. Platform, runner, and MCP releases have independent version sequences. Runner 0.8.5 includes completion-review recovery and updated telemetry dependencies. MCP server 0.8.0 remains unchanged.

This preview intentionally retains 15 screenshot placeholders in the in-app guides. Their descriptions explain the intended views; they are not captured product screenshots.

This remains a preview release. Runners are experimental; hosted deployment and end-user environment qualification are separate from source and packaging checks.
