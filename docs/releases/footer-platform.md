## Install or upgrade

The platform source bundle includes the production Compose configuration and installation documentation. Verify `SHA256SUMS` and unpack the archive. From inside the extracted directory, copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` and `OAUTH_STATE_SIGNING_KEY`, and run `docker compose -f docker-compose.prod.yml up -d`. Open `http://localhost:8080` to create the first administrator account.

Existing installations should back up their database and uploaded files before upgrading, and upgrade the platform before any runners. See [Self-hosting](../../README.md#self-hosting) for configuration and troubleshooting.

Platform, runner and MCP server releases have independent version sequences; this release does not republish the runner or MCP server. Preview releases are installable and tested, but interfaces may still change between previews.
