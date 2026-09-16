// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against WebhookEvent, the MCP CRUD tools, and EventEmitter.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote, WhatThisIsNot } from "../callouts";

export function OperatingWebhooksAndExternalNotifications() {
  return (
    <SectionPage
      title="Webhooks and External Notifications"
      eyebrow="Operating the Platform"
    >
      <p>
        A webhook sends selected workspace events to an external endpoint. Each
        active registration contains a delivery URL, a list of exact event
        names, and an HMAC secret. When one of those exact names is emitted, the
        backend makes one signed POST. There is no wildcard subscription
        matching and no webhook management screen in the current frontend.
      </p>

      <h2 id="management">Manage registrations through MCP</h2>
      <p>
        The complete management surface is <code>create_webhook</code>,{" "}
        <code>list_webhooks</code>, <code>get_webhook</code>, and <code>update_webhook</code>.
        Create requires URL, event list, and secret. List can filter by active
        state; get exposes delivery health but never returns the secret. Update
        changes only supplied fields, replaces the entire event list when{" "}
        <code>events</code> is present, rotates the secret, and can pause or
        resume with <code>is_active</code>. Passing <code>delete=true</code> to{" "}
        <code>update_webhook</code> removes the registration for good: it
        accepts no other field, and an already-missing registration is treated
        as a converged result.
      </p>
      <p>
        Current webhook mutation routes check workspace membership but set no
        minimum role. An owner, admin, member, or viewer can create, update, or
        delete a registration. Treat this as current behavior, not as an
        administrative authorization guarantee.
      </p>
      <p>
        Outside development, the URL must use HTTPS. Registration and URL
        updates resolve the host and reject loopback, private, link-local,
        reserved, multicast, and other non-global addresses. An unresolved host
        may still be registered and will fail later at delivery time.
      </p>
      <ImportantNote title="The signing secret is recoverable server-side">
        <code>WebhookRead</code> never returns the secret, but the backend must
        store it in recoverable form to calculate each HMAC. It is not an
        irreversibly hashed credential. Restrict database access, rotate the
        secret with <code>update_webhook</code>, and update the receiver at the
        same time.
      </ImportantNote>

      <h2 id="events">Supported exact event names</h2>
      <p>
        Use values from the backend's <code>WebhookEvent</code> enum. Activity
        subscriptions cover the exact entity and action pairs below; direct
        service events cover approvals, executions, runner status, config, and
        cost thresholds. Bare card and column bridge names remain only for
        backward compatibility, so new integrations should choose the activity
        names.
      </p>

      <CodeExample language="text" title="Current webhook event vocabulary">
        {`activity.card.created
activity.card.updated
activity.card.moved
activity.card.deleted
activity.card.dependency_added
activity.card.dependency_removed
activity.card.dependencies_replaced
activity.column.created
activity.column.updated
activity.column.deleted
activity.board.created
activity.board.updated
activity.board.deleted
activity.note.created
activity.note.updated
activity.note.deleted
activity.resource.created
activity.resource.updated
activity.resource.deleted
activity.definition.created
activity.definition.updated
activity.channel.created
activity.channel.updated
activity.channel.deleted
activity.git_repo.created
activity.git_repo.updated
activity.git_repo.deleted
activity.workspace.created
activity.workspace.updated
activity.member.added_member
activity.member.removed_member
approval.created
approval.updated
execution.started
execution.completed
agent.status_changed
config.changed
cost.threshold_crossed

# Deprecated bridge names
card.created
card.updated
card.moved
card.deleted
column.created
column.updated
column.deleted`}
      </CodeExample>

      <h2 id="delivery">Signed delivery and health</h2>
      <p>
        The backend serializes one JSON body containing <code>event</code>, a UTC
        <code>timestamp</code>, and <code>payload</code>. It signs the exact raw
        body with HMAC-SHA256 and sends the digest as{" "}
        <code>X-Webhook-Signature-256: sha256=&lt;hex&gt;</code>. The request also
        includes <code>X-Webhook-Event</code>. Receivers must verify the raw body
        before parsing it; re-serializing JSON can change the signed bytes.
      </p>

      <CodeExample language="http" title="Signed webhook request">
        {`POST /your/webhook/endpoint HTTP/1.1
Content-Type: application/json
X-Webhook-Event: activity.card.moved
X-Webhook-Signature-256: sha256=b7a8...e19c

{"event":"activity.card.moved","timestamp":"2026-04-19T14:03:22+00:00","payload":{"entity_type":"card","entity_id":"3f91...88d7","action":"moved"}}`}
      </CodeExample>

      <p>
        Delivery has a 5-second client timeout. Any HTTP status below 400 counts
        as success, resets <code>failure_count</code> to zero, and updates{" "}
        <code>last_delivered_at</code>. A timeout, network error, or status 400
        and above increments <code>failure_count</code>. After 10 consecutive failures,
        the backend automatically sets <code>is_active</code> to false. Inspect
        these fields with <code>list_webhooks</code> or{" "}
        <code>get_webhook</code>, then use <code>update_webhook</code> to resume
        after correcting the receiver.
      </p>

      <WhatThisIsNot title="No retry queue, outbox, or dead-letter store">
        Each matching event gets one delivery attempt. Failed attempts are not
        replayed, so webhook notifications are not a durable integration log.
        For critical synchronization, reconcile against Activity History and
        treat webhook delivery as the low-latency signal.
      </WhatThisIsNot>

      <ImportantNote title="Registration-time URL checks are not a complete network sandbox">
        The write-time guard reduces server-side request forgery risk, but it
        does not eliminate DNS rebinding or redirect-to-internal behavior at
        delivery time. Only register receivers you control and keep the signing
        secret scoped to that integration.
      </ImportantNote>
    </SectionPage>
  );
}
