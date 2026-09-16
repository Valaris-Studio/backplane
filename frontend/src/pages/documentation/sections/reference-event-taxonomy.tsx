// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from docs/events.md.

import { SectionPage } from "../shell/SectionPage";
import { HonestRemark } from "../callouts";

export function ReferenceEventTaxonomy() {
  return (
    <SectionPage title="Event Taxonomy" eyebrow="Reference">
      <p>
        Every relevant mutation publishes through the event-bus interface
        selected by <code>EVENT_BUS_BACKEND</code>. <code>memory</code> delivers
        only to subscribers in the same process; <code>postgres</code> preserves
        that local fan-out and adds cross-instance delivery through Postgres
        LISTEN/NOTIFY. Both feed WebSocket connections and the origin
        instance's external-webhook subscriber. Events carry a{" "}
        <code>workspace_id</code> and a <code>payload</code>; subscribers filter
        by <code>fnmatch</code> pattern (<code>activity.card.*</code>,{" "}
        <code>activity.*.deleted</code>, <code>*</code>).
      </p>
      <p>
        The authoritative surface is the <code>activity.*</code> namespace —
        <code>ActivityService.record</code> emits one of these for every
        entity mutation it records. The other namespaces carry events the
        activity fan-out doesn't cover: approvals, executions, runner
        lifecycle, config changes, cost alerts.
      </p>

      <h2 id="activity">activity.* — primary fan-out</h2>
      <p>
        Emitted as <code>activity.&#123;entity_type&#125;.&#123;action&#125;</code>.
        The payload matches the activity-log row (entity_id, action,
        actor_id, optional board_id, summary, changes).
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Namespace
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Actions emitted
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.card.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>moved</code>, <code>deleted</code>,{" "}
                <code>dependency_added</code>,{" "}
                <code>dependency_removed</code>,{" "}
                <code>dependencies_replaced</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.column.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>deleted</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.board.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>deleted</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.note.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>deleted</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.resource.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>deleted</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.definition.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.channel.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>deleted</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.git_repo.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>,{" "}
                <code>deleted</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.workspace.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>created</code>, <code>updated</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.member.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>added_member</code>, <code>removed_member</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>activity.agent.*</code>
              </td>
              <td className="py-3 pr-4">
                <code>updated</code>, <code>deleted</code> — lifecycle detail is
                carried in <code>changes.lifecycle</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="service-events">Service-owned event namespaces</h2>
      <p>
        Events published directly by their owning services — not activity
        rows. These carry service-specific payload shapes.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Event
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Publisher
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Key payload fields
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>approval.created</code>
              </td>
              <td className="py-3 pr-4">
                <code>ApprovalService.create_approval</code>
              </td>
              <td className="py-3 pr-4">
                <code>approval_id, status, category, risk_score,
                action_description, agent_id</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>approval.updated</code>
              </td>
              <td className="py-3 pr-4">
                <code>ApprovalService.decide</code>
              </td>
              <td className="py-3 pr-4">
                <code>approval_id, status, decided_by, decision_reason</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>execution.started</code>
              </td>
              <td className="py-3 pr-4">
                <code>ExecutionService.start_execution</code>
              </td>
              <td className="py-3 pr-4">
                <code>execution_id, agent_id, action, input_summary,
                board_id</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>execution.completed</code>
              </td>
              <td className="py-3 pr-4">
                <code>ExecutionService.update_execution</code> (terminal
                status)
              </td>
              <td className="py-3 pr-4">
                <code>execution_id, status, cost_usd, tokens_used,
                output_summary, error_message</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>execution.warning</code>
              </td>
              <td className="py-3 pr-4">
                <code>ExecutionService.record_warning</code>
              </td>
              <td className="py-3 pr-4">
                <code>execution_id, agent_id, card_id, board_id, kind,
                message</code>; an in-flight warning, not completion
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>agent.status_changed</code>
              </td>
              <td className="py-3 pr-4">
                <code>AgentService</code> on activate / deactivate / re-
                activate
              </td>
              <td className="py-3 pr-4">
                <code>agent_id, is_active, previous_active</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>agent.poll_requested</code>
              </td>
              <td className="py-3 pr-4">
                <code>AgentService.poll_agent</code> (WS-gated; 503 without
                an active connection)
              </td>
              <td className="py-3 pr-4">
                <code>target_agent_id</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>agent.heartbeat_received</code>
              </td>
              <td className="py-3 pr-4">
                <code>AgentService.handle_ws_heartbeat</code>
              </td>
              <td className="py-3 pr-4">
                <code>agent_id, status, last_seen_at, liveness</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>agent.paused</code>, <code>agent.resumed</code>
              </td>
              <td className="py-3 pr-4">
                <code>AgentService.pause_agent / resume_agent</code>
              </td>
              <td className="py-3 pr-4">
                <code>agent_id, is_paused</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>agent.restart_requested</code>,{" "}
                <code>agent.hard_deleted</code>
              </td>
              <td className="py-3 pr-4">
                <code>AgentService.restart_agent / hard_delete_agent</code>
              </td>
              <td className="py-3 pr-4">
                <code>target_agent_id</code> for restart; <code>agent_id</code>{" "}
                for deletion
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>board.loop_updated</code>
              </td>
              <td className="py-3 pr-4">
                <code>BoardService</code> after a loop-state change
              </td>
              <td className="py-3 pr-4">
                <code>workspace_id, board_id, enabled, version,
                disabled_reason</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>api_key.first_used</code>
              </td>
              <td className="py-3 pr-4">
                <code>ApiKeyService</code> on the key's first-ever use
              </td>
              <td className="py-3 pr-4">
                <code>api_key_id, user_id, key_name, last_used_at</code>;
                WebSocket delivery is restricted to that user
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>notification.created</code>
              </td>
              <td className="py-3 pr-4">
                In-app notification channel, after the outer transaction commits
              </td>
              <td className="py-3 pr-4">
                <code>notification_id, recipient_user_id, category,
                workspace_id, unread_delta, link</code>; WebSocket delivery is
                restricted to the recipient
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>merge_queue.enqueued</code> through{" "}
                <code>merge_queue.ci_not_green</code>
              </td>
              <td className="py-3 pr-4">
                <code>MergeQueueService</code>
              </td>
              <td className="py-3 pr-4">
                <code>entry_id, card_id, repo_id, integration_branch, pr_url,
                pr_branch, state, attempt_count</code>, plus outcome fields
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>merge_queue.stale</code>
              </td>
              <td className="py-3 pr-4">
                <code>BoardHealthService</code> on the first stale detection
              </td>
              <td className="py-3 pr-4">
                Queue identity plus <code>board_id, age_seconds,
                classification</code>; latched to emit once per entry
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>merge_queue.conflict_consolidator_created</code>
              </td>
              <td className="py-3 pr-4">
                <code>ConsolidatorCardCreator</code>
              </td>
              <td className="py-3 pr-4">
                <code>entry_id, original_card_id, consolidator_card_id</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>board.loop_updated</code>
              </td>
              <td className="py-3 pr-4">
                <code>BoardService</code> on loop config save, enable /
                disable, and loop-template bind / re-render / detach
              </td>
              <td className="py-3 pr-4">
                <code>workspace_id, board_id, enabled, version,
                disabled_reason</code> — deliberately thin (the NOTIFY
                payload cap); clients refetch rather than read state off
                the event
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>config.changed</code>
              </td>
              <td className="py-3 pr-4">
                Agent / team / prompt_config / workspace_config /
                loop_template services
              </td>
              <td className="py-3 pr-4">
                <code>entity, action, entity_id</code> — plus{" "}
                <code>slug, version</code> when{" "}
                <code>entity = loop_template</code>, whose actions extend
                beyond created/updated/deleted to{" "}
                <code>published, archived, unarchived, restored</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>cost.threshold_crossed</code>
              </td>
              <td className="py-3 pr-4">
                <code>AlertThresholdService</code>
              </td>
              <td className="py-3 pr-4">
                <code>threshold_id, metric, operator, target_value,
                current_value, workspace_id, board_id</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="deprecated">Deprecated — bridge events (still firing)</h2>
      <p>
        Before the <code>activity.*</code> fan-out existed, the platform
        emitted un-namespaced lifecycle events directly. A small number of
        these still publish in parallel with their <code>activity.*</code>{" "}
        twin so pre-migration subscribers don't break. New code should not
        subscribe to these.
      </p>
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Event
              </th>
              <th className="text-muted-foreground text-xs uppercase tracking-wide py-2 pr-4">
                Replacement
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>card.created</code>, <code>card.updated</code>,{" "}
                <code>card.moved</code>, <code>card.deleted</code>
              </td>
              <td className="py-3 pr-4">
                <code>activity.card.&#123;action&#125;</code>
              </td>
            </tr>
            <tr className="border-b border-border align-top">
              <td className="py-3 pr-4">
                <code>column.created</code>, <code>column.updated</code>,{" "}
                <code>column.deleted</code>
              </td>
              <td className="py-3 pr-4">
                <code>activity.column.&#123;action&#125;</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2 id="delivery-boundaries">Delivery boundaries</h2>
      <p>
        The live EventBus and WebSocket surface is broader than the public
        webhook selector. The <code>WebhookEvent</code> schema currently
        exposes the bridge events, the listed <code>activity.*</code> pairs
        through <code>activity.member.*</code>, and the original approval,
        execution, agent-status, config, and cost events. It does not expose{" "}
        <code>activity.agent.*</code> or the newer direct events such as{" "}
        <code>execution.warning</code>, <code>agent.paused</code>,{" "}
        <code>agent.resumed</code>, <code>agent.restart_requested</code>,{" "}
        <code>agent.hard_deleted</code>, <code>board.loop_updated</code>,{" "}
        <code>api_key.first_used</code>, <code>notification.created</code>, or{" "}
        <code>merge_queue.*</code>. Those names cannot be selected through the
        webhook create or update API today.
      </p>
      <p>
        Two additional names, <code>agent.restart_probe</code> and{" "}
        <code>agent.restart_ack</code>, coordinate restart discovery between
        backend workers. The connection manager explicitly suppresses them
        from client WebSockets. <code>notification.created</code> and{" "}
        <code>api_key.first_used</code> are also filtered per user rather than
        broadcast to every workspace member.
      </p>

      <HonestRemark title="A live notification bus is not an audit log">
        Both backends provide at-most-once delivery with no replay. The memory
        backend also stops at the process boundary; Postgres LISTEN/NOTIFY
        closes that visibility gap but is still not a durable queue. Use the
        persisted activity, execution, approval, notification, and merge-queue
        rows as the source of truth, and treat events as prompts to refetch.
      </HonestRemark>
    </SectionPage>
  );
}
