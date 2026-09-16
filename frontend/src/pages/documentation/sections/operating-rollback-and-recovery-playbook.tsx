// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/platform-source-of-truth.md §11 and
// CLAUDE.md "Production & Deployment Quirks" + "Migration Safety".

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone, ImportantNote } from "../callouts";

export function OperatingRollbackAndRecoveryPlaybook() {
  return (
    <SectionPage
      title="Rollback and Recovery Playbook"
      eyebrow="Operating the Platform"
    >
      <p>
        Two classes of recovery matter once you're running this in production:{" "}
        <em>revert a bad deploy</em> and <em>recover data from the database</em>.
        How you do either depends on how you're hosting Backplane — a
        docker-compose host, a managed container platform, bare VMs behind a
        load balancer. The mechanics below are the general shape; where a
        specific platform's commands are shown, they're one example, not the
        only path.
      </p>

      <h2 id="revision-rollback">Reverting a bad deploy</h2>
      <p>
        The backend and frontend are ordinary containers built from the
        images in this repo (see <code>backend/Dockerfile</code>,{" "}
        <code>frontend/Dockerfile</code>). "Rolling back" means running the
        previous image again, not rebuilding or reverting code:
      </p>
      <ul>
        <li>
          <strong>docker compose:</strong> re-tag or re-pull the last
          known-good image and <code>docker compose up -d</code> to recreate
          the affected service. If you're building locally,{" "}
          <code>git checkout</code> the last-good commit and rebuild.
        </li>
        <li>
          <strong>Any platform with revision/rollout history</strong>{" "}
          (Kubernetes, Cloud Run, Nomad, ECS, …): use that platform's native
          rollback — shifting traffic or redeploying a pinned image tag —
          rather than rebuilding from source. Keeping the last few images
          around is what makes this fast.
        </li>
      </ul>

      <CodeExample
        language="bash"
        title="On Google Cloud Run — the maintainer's own deployment target"
      >
        {`# List revisions in recent-first order to find the last known-good one.
gcloud run revisions list \\
  --service <your-backend-service> \\
  --region <your-region> \\
  --limit 10

# Shift 100% traffic to that revision.
gcloud run services update-traffic <your-backend-service> \\
  --region <your-region> \\
  --to-revisions <your-backend-service>-00042-abc=100

# Verify — the 'TRAFFIC' column should now read '100%' on the target revision.
gcloud run services describe <your-backend-service> \\
  --region <your-region> \\
  --format 'value(status.traffic)'`}
      </CodeExample>
      <p>
        On Cloud Run specifically, this is effective in seconds — traffic
        re-assignment, not a rebuild, and no cold-start penalty on an
        already-warm revision. The same "keep the old thing running, just
        stop sending traffic to the new thing" principle applies whatever
        you're running on.
      </p>

      <h2 id="database-recovery">Database recovery</h2>
      <p>
        Backplane runs on Postgres (16, in the provided docker-compose
        setup). This app has no built-in backup/restore tooling of its own —
        recovery is whatever backup strategy you've put in front of your
        Postgres instance: <code>pg_dump</code>/<code>pg_restore</code> on a
        schedule, volume snapshots, or a managed Postgres provider's
        point-in-time recovery (PITR) if you're using one.
      </p>
      <p>
        Whichever mechanism you use, the same rule holds: recovery should be
        an out-of-place restore to a new instance or database, validated
        separately, then promoted. Never restore in-place over a live
        production database — if the restore is wrong, you want the broken
        original still there.
      </p>

      <CodeExample
        language="bash"
        title="On Google Cloud SQL — the maintainer's own deployment target"
      >
        {`# Clone as of a specific timestamp. ISO-8601 UTC.
gcloud sql instances clone <your-db-instance> <your-db-instance>-restore-2026-04-19 \\
  --point-in-time '2026-04-19T13:55:00Z'

# Connect to the clone and validate the state (spot-check affected rows).
gcloud sql connect <your-db-instance>-restore-2026-04-19 --database valaris --user postgres

# If validated, update the backend's DATABASE_URL to point at the restored
# instance, roll out, and retire the old one. If not, delete the clone and try
# a different timestamp.`}
      </CodeExample>

      <ImportantNote title="Verify DATABASE_URL before any Alembic invocation">
        If your Postgres instance hosts more than one database — this app
        plus anything else you run alongside it — Alembic obeys whatever URL{" "}
        <code>app.config.settings</code> hands it, and <em>it will happily
        migrate the wrong database</em> if the env is pointing there. Before
        any <code>alembic upgrade head</code>, an Alembic downgrade, or a
        manual SQL session, print the resolved URL and confirm the database
        name is the one you think it is. Two minutes of paranoia here beats
        an afternoon of cleanup.
      </ImportantNote>

      <DangerZone title="Database migrations do not roll back — they are superseded">
        Rolling deploys (any platform that replaces instances gradually
        rather than all-at-once) mean for a brief window <em>both</em> old
        and new application code run against the new schema. That is the
        whole reason migrations must be forward-compatible (add nullable
        columns, never drop read-live columns, never rename — see Migration
        Safety in the project's own developer docs).
        <br />
        <br />
        The corollary: you cannot fix a broken migration by editing the
        landed revision. Once a migration has been applied to production, it
        is a historical fact. A fix is a <em>new</em> migration that
        supersedes the old one — add the correction, bump the revision,
        deploy forward. Never run an Alembic downgrade in production. Never
        edit a committed migration file and redeploy. Never drop a column in
        the same release that stops reading it; that is a two-deploy dance,
        always.
      </DangerZone>
    </SectionPage>
  );
}
