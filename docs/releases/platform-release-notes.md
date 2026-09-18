# Backplane platform 0.1.1-preview.1

This preview improves first-install reliability and mobile navigation.

- Failed attachment uploads no longer create successful-looking attachment records. The reverse proxy accepts uploads up to the documented limit.
- PostgreSQL passwords containing URL-reserved characters work without manually encoding credentials.
- Dependency updates address reported security advisories. Database transactions finish before a successful API response is sent.
- Cold database restore instructions wait for PostgreSQL readiness and identify the correct storage volume.
- Mobile navigation keeps account controls reachable and groups utility actions into an accessible menu.

The platform source bundle includes the production Compose configuration and installation documentation. Verify `SHA256SUMS` and unpack the archive. From inside the extracted directory, copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` and `OAUTH_STATE_SIGNING_KEY`, and run `docker compose -f docker-compose.prod.yml up -d`. Open `http://localhost:8080` to create the first administrator account. These steps build the selected release directly from the archive.

See [Self-hosting](../../README.md#self-hosting) for configuration and troubleshooting. Existing installations should back up the database and uploaded files before upgrading.

Runner 0.8.4 and MCP server 0.8.0 remain unchanged; this release does not republish them. Platform, runner, and MCP releases have independent version sequences.

This remains a preview release. Hosted deployment and end-user environment qualification are separate from source and packaging checks.
