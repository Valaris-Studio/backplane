// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runtime contract: docker-compose.prod.yml and backend/start-prod.sh.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone, ImportantNote, ProTip } from "../callouts";

export function InstallingUpgradingBackplane() {
  return (
    <SectionPage title="Upgrading Backplane" eyebrow="Installing Backplane">
      <p>
        Upgrading the production Compose deployment means choosing a reviewed
        source revision, rebuilding backend and frontend from that checkout,
        and recreating the services. Those application services are not
        currently upgraded by pulling published Backplane image tags.
      </p>

      <ImportantNote title="Take a complete backup before changing the checkout">
        Follow Backup and Restore for the Postgres dump, uploaded files or GCS
        bucket, and .env secrets. A database dump alone is not a complete
        rollback point.
      </ImportantNote>

      <h2 id="the-upgrade">Build the reviewed revision</h2>
      <p>
        Start from a clean deployment checkout. Fetch the repository, inspect
        the target commit or release, and check out that exact revision. Do not
        use an unreviewed moving branch as a production version.
      </p>
      <CodeExample language="bash" title="Rebuild and recreate">
        {`BACKPLANE_TARGET_REVISION=replace-with-reviewed-commit-or-release
git status --short
git fetch --tags origin
git checkout "$BACKPLANE_TARGET_REVISION"

docker compose -f docker-compose.prod.yml build --pull backend frontend
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs backend`}
      </CodeExample>
      <p>
        backend/start-prod.sh runs python -m alembic upgrade head before
        gunicorn. It tries the migration up to five times with a five-second
        pause. A backend that never reaches Starting production server... has
        not completed the upgrade.
      </p>

      <DangerZone title="Compose recreation can interrupt requests">
        This deployment is not documented as zero-downtime. Recreating the
        backend or frontend can cause a brief interruption, and a long
        migration can extend it. Schedule a maintenance window when downtime
        matters, especially for an old database or an untested migration gap.
      </DangerZone>

      <h2 id="migration-gaps">Alembic handles missing revisions in order</h2>
      <p>
        Alembic upgrades from the database's current revision to head through
        every missing migration. You do not need to boot every intervening
        application release. For a large version gap, rehearse the exact
        upgrade against a restored copy first so duration and data-dependent
        failures are known before production.
      </p>

      <h2 id="after">Verify the result</h2>
      <CodeExample language="bash" title="Check services, readiness, and schema">
        {`docker compose -f docker-compose.prod.yml ps
curl -fsS http://localhost:8080/api/ready
docker compose -f docker-compose.prod.yml exec -T backend \
  python -m alembic current`}
      </CodeExample>
      <p>
        Confirm the Alembic output marks the current revision as head. Then log
        in, open an existing board, reload it, and inspect backend logs for
        migration, startup, authentication, or WebSocket errors. If you operate
        a separately configured runner, verify it independently after the
        platform is healthy.
      </p>

      <DangerZone title="A forward migration is not undone by old source">
        Checking out an older commit does not reverse a schema migration and
        may start incompatible code against the newer schema. Recover by
        restoring the complete pre-upgrade backup into a controlled stack, or
        by applying a reviewed forward fix. Do not edit an applied migration or
        assume alembic downgrade is a safe production rollback.
      </DangerZone>

      <ProTip title="Record the source SHA beside every backup">
        Store the exact git commit, Compose project name, and backup timestamp
        together. A restore is reproducible only when the database, files,
        secrets, and source revision can be matched.
      </ProTip>
    </SectionPage>
  );
}
