// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runtime contract: docker-compose.prod.yml, .env.example and backend/start-prod.sh.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, DangerZone, ImportantNote, ProTip } from "../callouts";

export function InstallingInstallWithDockerCompose() {
  return (
    <SectionPage
      title="Install with Docker Compose"
      eyebrow="Installing Backplane"
    >
      <p>
        The documented production core is three core containers: Postgres,
        the FastAPI backend, and the nginx frontend. The optional runner is a
        fourth service behind a Compose profile, but that profile is not part
        of the first successful platform boot.
      </p>

      <h2 id="what-you-get">What the default stack contains</h2>
      <ul>
        <li>
          Postgres 16 stores boards, cards, users, executions, and events in
          the postgres-data named volume.
        </li>
        <li>
          The backend waits for Postgres, runs Alembic migrations, and then
          starts gunicorn. It has no host port.
        </li>
        <li>
          The frontend serves the SPA on the only published port and proxies
          /api and /ws to the backend.
        </li>
      </ul>
      <p>
        Uploaded resources use the backplane-storage volume when GCS_BUCKET is
        empty. runner-repos exists for the optional runner profile, not for the
        three-service core.
      </p>

      <h2 id="prerequisites">Before you start</h2>
      <p>
        Use a recent Docker installation with the Compose v2 command, written
        as docker compose. The repository does not declare a tested minimum
        Docker version or RAM requirement, so verify capacity for your own
        host rather than treating an undocumented number as a guarantee.
      </p>

      <h2 id="configure">Create and review .env</h2>
      <p>
        Copy the tracked example, then replace the existing values in .env.
        Do not append duplicate keys: which duplicate wins depends on the
        parser and makes the resulting deployment hard to audit.
      </p>

      <CodeExample language="bash" title="Fetch the source and generate secrets">
        {`git clone https://github.com/valaris-studio/backplane.git
cd backplane
cp .env.example .env

# Generate values, then paste each into the matching existing line in .env.
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -hex 32      # OAUTH_STATE_SIGNING_KEY`}
      </CodeExample>

      <p>The minimum decisions for a local production boot are:</p>
      <ul>
        <li>
          POSTGRES_PASSWORD is required. POSTGRES_USER and POSTGRES_DB both
          default to backplane.
        </li>
        <li>
          OAUTH_STATE_SIGNING_KEY is required by docker-compose.prod.yml. The
          backend uses it for built-in local or OIDC login sessions and for
          OAuth and OIDC state.
        </li>
        <li>
          BACKPLANE_URL defaults to http://localhost:8080 and feeds the
          frontend, API, CORS, and callback URLs. BACKPLANE_HTTP_PORT defaults
          to 8080.
        </li>
        <li>
          LOCAL_AUTH_ENABLED defaults to true. A fresh database presents the
          first-run administrator setup before the workspace picker. Configure
          OIDC, IAP, or trusted-proxy authentication before exposing the host
          beyond localhost.
        </li>
      </ul>

      <ImportantNote title="The application services build from this checkout">
        docker-compose.prod.yml declares build contexts and pull_policy: build
        for backend and frontend. The repository explicitly says those two
        application images are not yet published, even though image names are
        present in the file. Your checkout is therefore the version you run;
        do not expect a tag change or docker compose pull to upgrade it.
      </ImportantNote>

      <h2 id="first-boot">Build and start the platform</h2>
      <CodeExample language="bash" title="Start and verify the core stack">
        {`docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs backend
curl -fsS http://localhost:8080/api/ready`}
      </CodeExample>
      <p>
        A successful backend boot logs Running database migrations... and
        Starting production server.... The readiness request must return
        successfully; a zero exit code from Compose alone does not prove that
        the application is usable. Open http://localhost:8080, complete the
        first-run administrator setup, and then create or select a workspace.
      </p>

      <p>Demo data is optional and requires an explicit account email:</p>
      <CodeExample language="bash" title="Optionally seed a demo workspace">
        {`docker compose -f docker-compose.prod.yml exec -T backend \
  python -m scripts.seed_demo --email you@example.com

# The seed is idempotent. Use --force only after reviewing an existing instance.`}
      </CodeExample>

      <ImportantNote title="Only the frontend port is published">
        Keep the backend and Postgres private on the Compose network. Every
        browser request should enter through nginx on the frontend. Publishing
        port 8000 creates a path around the intended front door and its
        authentication topology.
      </ImportantNote>

      <DangerZone title="Never expose the development Compose stack">
        docker-compose.yml is for local development and trusts X-User-Email as
        identity. Production self-hosting uses docker-compose.prod.yml, which
        sets ENV=production and refuses to start when every production
        authentication verifier is disabled.
      </DangerZone>

      <h2 id="add-a-runner">The bundled runner profile is not turnkey</h2>
      <p>
        The current runner profile mounts one YAML file at
        /etc/backplane/runner.yaml. The example YAML points to mcp-config.json,
        but Compose does not provide the second mount for that MCP file. As
        shipped, starting the profile can therefore leave the runner without
        its required MCP configuration. This limitation does not prevent the
        three core services from being installed and verified.
      </p>
      <p>
        Register a runner in the UI and follow the two-file, explicit -config
        flow in the Registering a Runner and Your First Pipeline Run pages.
        Do not treat docker compose --profile runner up as a complete runner
        installation until your deployment supplies both files at matching
        in-container paths.
      </p>

      <ProTip title="Verify persisted behavior, not only health">
        After the readiness check, create a workspace, board, and card, reload
        the page, and restart the three core services normally. Confirm the
        card still exists. That covers authentication, migrations, Postgres,
        nginx proxying, and basic persistence in one small smoke test.
      </ProTip>
    </SectionPage>
  );
}
