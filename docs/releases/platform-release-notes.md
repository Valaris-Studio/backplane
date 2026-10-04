# Backplane platform 0.1.3-preview.1

This preview collects interface fixes published to source since 0.1.2-preview.2 and documents MCP server 0.8.1.

- Mention notifications show their target and link to it; linked notes reopen from their deep link.
- Frontend deployments keep previously built assets, so open pages no longer go blank after an upgrade, and failed page loads recover.
- The card detail panel lists notes linked to the card and shows its branch name.
- Binding a loop template announces when the board's done gate will be relaxed for self-merge loops; re-rendering a template never relaxes it.
- Spanish translations restore their accents and diacritics.
- CI checks that the diagram renderer stays out of eagerly loaded frontend bundles.

The platform source bundle includes the production Compose configuration and installation documentation. Verify `SHA256SUMS` and unpack the archive. From inside the extracted directory, copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` and `OAUTH_STATE_SIGNING_KEY`, and run `docker compose -f docker-compose.prod.yml up -d`. Open `http://localhost:8080` to create the first administrator account.

Existing installations should back up their database and uploaded files before upgrading. This release adds no database migrations. Upgrade the backend before upgrading runners.

See [Self-hosting](../../README.md#self-hosting) for configuration and troubleshooting. Platform, runner, and MCP releases have independent version sequences. Runner 0.8.5 remains current. MCP server 0.8.1, already on PyPI, adds an optional default board from `VALARIS_DEFAULT_*` environment variables and refuses malformed workspace slugs in `create_workspace`; its source is now included.

This preview intentionally retains 15 screenshot placeholders in the in-app guides. Their descriptions explain the intended views; they are not captured product screenshots.

This remains a preview release. Runners are experimental; hosted deployment and end-user environment qualification are separate from source and packaging checks.
