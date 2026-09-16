# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

# Bridge events — emitted in parallel with their activity.* twin by
# ActivityService.record. DEPRECATED; see docs/events.md. Sunset planned
# after consumers migrate. Do NOT add new bridge events.
CARD_CREATED = "card.created"
CARD_UPDATED = "card.updated"
CARD_MOVED = "card.moved"
CARD_DELETED = "card.deleted"
COLUMN_CREATED = "column.created"
COLUMN_UPDATED = "column.updated"
COLUMN_DELETED = "column.deleted"

# activity.{entity}.{action} namespace — emitted by ActivityService.record
# for every (entity, action) pair the codebase records. Constants mirror the
# WebhookEvent enum so webhook subscribers can opt in per-pair.
ACTIVITY_CARD_CREATED = "activity.card.created"
ACTIVITY_CARD_UPDATED = "activity.card.updated"
ACTIVITY_CARD_MOVED = "activity.card.moved"
ACTIVITY_CARD_DELETED = "activity.card.deleted"
ACTIVITY_CARD_DEPENDENCY_ADDED = "activity.card.dependency_added"
ACTIVITY_CARD_DEPENDENCY_REMOVED = "activity.card.dependency_removed"
ACTIVITY_CARD_DEPENDENCIES_REPLACED = "activity.card.dependencies_replaced"
ACTIVITY_COLUMN_CREATED = "activity.column.created"
ACTIVITY_COLUMN_UPDATED = "activity.column.updated"
ACTIVITY_COLUMN_DELETED = "activity.column.deleted"
ACTIVITY_BOARD_CREATED = "activity.board.created"
ACTIVITY_BOARD_UPDATED = "activity.board.updated"
ACTIVITY_BOARD_DELETED = "activity.board.deleted"
ACTIVITY_NOTE_CREATED = "activity.note.created"
ACTIVITY_NOTE_UPDATED = "activity.note.updated"
ACTIVITY_NOTE_DELETED = "activity.note.deleted"
ACTIVITY_RESOURCE_CREATED = "activity.resource.created"
ACTIVITY_RESOURCE_UPDATED = "activity.resource.updated"
ACTIVITY_RESOURCE_DELETED = "activity.resource.deleted"
ACTIVITY_DEFINITION_CREATED = "activity.definition.created"
ACTIVITY_DEFINITION_UPDATED = "activity.definition.updated"
ACTIVITY_CHANNEL_CREATED = "activity.channel.created"
ACTIVITY_CHANNEL_UPDATED = "activity.channel.updated"
ACTIVITY_CHANNEL_DELETED = "activity.channel.deleted"
ACTIVITY_GIT_REPO_CREATED = "activity.git_repo.created"
ACTIVITY_GIT_REPO_UPDATED = "activity.git_repo.updated"
ACTIVITY_GIT_REPO_DELETED = "activity.git_repo.deleted"
ACTIVITY_WORKSPACE_CREATED = "activity.workspace.created"
ACTIVITY_WORKSPACE_UPDATED = "activity.workspace.updated"
ACTIVITY_MEMBER_ADDED = "activity.member.added_member"
ACTIVITY_MEMBER_REMOVED = "activity.member.removed_member"

APPROVAL_CREATED = "approval.created"
APPROVAL_UPDATED = "approval.updated"
EXECUTION_STARTED = "execution.started"
EXECUTION_COMPLETED = "execution.completed"
# Typed, in-flight runner warning surface. Not a completion signal — the
# underlying retry continues. Carries {agent_id, execution_id, card_id,
# kind, message}; consumers switch on `kind`. See app/services/agents/
# execution.py::ExecutionService.record_warning.
EXECUTION_WARNING = "execution.warning"
AGENT_STATUS_CHANGED = "agent.status_changed"
AGENT_POLL_REQUESTED = "agent.poll_requested"
AGENT_HEARTBEAT_RECEIVED = "agent.heartbeat_received"
AGENT_PAUSED = "agent.paused"
AGENT_RESUMED = "agent.resumed"
AGENT_RESTART_REQUESTED = "agent.restart_requested"
# Internal worker-to-worker pair. connection_manager is a per-process singleton
# while the bus crosses processes, so a restart POST cannot see a socket held by
# a sibling gunicorn worker. The handling worker probes; whichever worker owns
# the socket delivers the restart and acks. Never sent to WS clients.
AGENT_RESTART_PROBE = "agent.restart_probe"
AGENT_RESTART_ACK = "agent.restart_ack"
AGENT_HARD_DELETED = "agent.hard_deleted"
CONFIG_CHANGED = "config.changed"
COST_THRESHOLD_CROSSED = "cost.threshold_crossed"
BOARD_LOOP_UPDATED = "board.loop_updated"

# Fires once per API key, ever: the never-used -> used transition. Per-user,
# not workspace-broadcast — ConnectionManager._should_deliver matches
# payload["user_id"] against the socket's user. Drives the MCP connection
# wizard's "your coding agent connected" step.
API_KEY_FIRST_USED = "api_key.first_used"
