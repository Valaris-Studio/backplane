// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { ImportantNote } from "../callouts";

export function GettingStartedCreatingYourFirstWorkspace() {
  return (
    <SectionPage title="Creating Your First Workspace" eyebrow="Getting Started">
      <p>
        After login, the root route shows the workspace picker. It lists every
        workspace your account can access and offers Create workspace. The
        global language switcher currently offers English, Spanish, and
        Brazilian Portuguese.
      </p>

      <h2 id="create">Name and slug</h2>
      <p>
        The create dialog asks for a human-readable name and a URL slug. Keep
        the slug short, lowercase, and hyphenated because it appears in routes
        such as /acme-ops/boards, /acme-ops/runner, and /acme-ops/settings.
      </p>
      <ImportantNote title="The workspace slug is immutable">
        Workspace updates can change the display name, but the current API has
        no slug rename operation. Links, webhooks, and runner scope depend on
        that identifier, so choose it as a permanent value.
      </ImportantNote>

      <h2 id="roles">The creator becomes an owner</h2>
      <p>
        The creating account is added as the first owner. Workspace roles are
        owner, admin, member, and viewer, ordered from highest to lowest
        authority. Owners and admins perform workspace management; only an
        owner can grant or manage the owner role. Viewers are read-only.
      </p>
      <p>
        Add people later from /&#123;slug&#125;/members. Give each person the
        least privilege they need, and keep at least one reachable owner
        account for membership and destructive workspace decisions.
      </p>

      <h2 id="dashboard">The first workspace dashboard</h2>
      <p>
        Successful creation routes to /&#123;slug&#125;. The welcome checklist
        guides you through creating a board, adding a project definition and
        notes, inviting the team, opening a channel, and connecting git. The
        runner link appears separately when the workspace is ready for
        automation.
      </p>
      <p>
        For a personal evaluation, create the board next. For a team pilot,
        add collaborators early so the board, notes, and decisions are shared
        from the start.
      </p>
      <p>
        Once activity exists, the dashboard shows an activity trend panel with
        a 7-day and a 30-day view. The payload always carries the full 30
        days, so switching ranges never costs a request. Hover the sparkline
        to read a per-day breakout — date plus event count — with a marker on
        the plotted point; the same readout is keyboard-reachable (focus the
        chart, then arrow keys, Home, End; Escape dismisses) and announced to
        screen readers. On touch screens the chart stays a plain trend line.
      </p>
    </SectionPage>
  );
}
