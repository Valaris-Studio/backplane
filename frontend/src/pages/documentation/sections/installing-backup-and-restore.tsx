// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Storage contract: docker-compose.prod.yml and backend resource configuration.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone, ImportantNote, ProTip } from "../callouts";

export function InstallingBackupAndRestore() {
  return (
    <SectionPage title="Backup and Restore" eyebrow="Installing Backplane">
      <p>
        A recoverable self-hosted backup includes the Postgres database, every
        uploaded resource, and the complete .env file. Record the source commit
        and Compose project name with those artifacts.
      </p>

      <h2 id="database">Dump Postgres</h2>
      <CodeExample language="bash" title="Create a custom-format dump">
        {`# Adjust the user and database if POSTGRES_USER or POSTGRES_DB changed.
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -Fc -U backplane backplane > backplane-$(date +%F).dump`}
      </CodeExample>
      <p>
        The custom format is compressed and can be restored selectively.
        Running pg_dump against the live database is transactionally
        consistent; -T prevents a TTY from corrupting the binary stream.
      </p>

      <h2 id="storage">Back up the active resource store</h2>
      <p>
        When GCS_BUCKET is empty, uploads live in the backplane-storage named
        volume at /data/resources. Docker prefixes the volume with the Compose
        project name. Confirm the real name with docker volume ls before using
        it; do not copy the example prefix blindly.
      </p>
      <CodeExample language="bash" title="Archive local uploaded resources">
        {`docker volume ls

# Replace this example value with the confirmed volume name.
BACKPLANE_RESOURCE_VOLUME=backplane_backplane-storage
docker volume inspect "$BACKPLANE_RESOURCE_VOLUME"
docker run --rm \
  -v "$BACKPLANE_RESOURCE_VOLUME:/data:ro" \
  -v "$PWD":/backup \
  alpine tar czf /backup/backplane-storage-$(date +%F).tar.gz -C /data .`}
      </CodeExample>
      <ImportantNote title="GCS deployments need a bucket backup instead">
        When GCS_BUCKET is set, the bucket is the authoritative upload store;
        archiving the local named volume does not protect those objects. Use
        your cloud provider's versioning or backup procedure and verify that
        the bucket recovery point matches the database dump.
      </ImportantNote>

      <h2 id="env">Protect .env as a credential backup</h2>
      <p>
        Store .env in an encrypted secrets system away from the deployment
        disk. It contains database credentials, OAUTH_STATE_SIGNING_KEY,
        INTEGRATIONS_TOKEN_KEY, and any configured provider secrets.
      </p>
      <DangerZone title="Lost encryption and signing keys cannot be reconstructed">
        INTEGRATIONS_TOKEN_KEY decrypts stored git-connection OAuth tokens;
        without it those database values are unusable. Changing
        OAUTH_STATE_SIGNING_KEY invalidates signed login sessions and OAuth or
        OIDC state. Restore the original keys deliberately instead of
        generating replacements during recovery.
      </DangerZone>

      <h2 id="restore">Restore into a controlled stack</h2>
      <p>
        Put the backed-up .env and the intended source revision in place first.
        Keep backend and frontend stopped while replacing the database and
        files. The example below assumes local volume storage.
      </p>
      <CodeExample language="bash" title="Restore database and local resources">
        {`BACKPLANE_RESTORE_REVISION=replace-with-recorded-source-commit
git checkout "$BACKPLANE_RESTORE_REVISION"
cp /secure/backup/.env .
docker compose -f docker-compose.prod.yml up -d postgres

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U backplane -d backplane --clean --if-exists \
  < backplane-2026-07-25.dump

BACKPLANE_RESOURCE_VOLUME=backplane_backplane-storage
docker volume inspect "$BACKPLANE_RESOURCE_VOLUME"
docker run --rm \
  -v "$BACKPLANE_RESOURCE_VOLUME:/data" \
  -v "$PWD":/backup \
  alpine sh -c "tar xzf /backup/backplane-storage-2026-07-25.tar.gz -C /data"

docker compose -f docker-compose.prod.yml up -d --build`}
      </CodeExample>

      <ImportantNote title="Newer source automatically upgrades an older dump">
        If you intentionally start a newer checkout, backend startup applies
        every missing Alembic revision before serving requests. To inspect the
        old schema unchanged, use the recorded source commit in an isolated
        environment and do not start a newer backend against it.
      </ImportantNote>

      <h2 id="drills">Test recovery regularly</h2>
      <p>
        Restore into a separate Compose project and port. Verify readiness,
        login, an existing board and card, and at least one uploaded resource.
        For GCS, verify an object restored from the matching bucket recovery
        point. A backup is not proven until this drill succeeds.
      </p>

      <ProTip title="Verify artifacts, retention, and source identity">
        Automate size and checksum checks, retain more than one recovery point,
        and record git rev-parse HEAD. A fresh zero-byte dump or an unlabeled
        archive is not a usable backup.
      </ProTip>
    </SectionPage>
  );
}
