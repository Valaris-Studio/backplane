// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Wire shapes of contract A, mirroring the Go JSON field for field: fields
//! Go always emits are required, pointer and `omitempty` fields are `Option`,
//! and slices Go may marshal as `null` decode as empty. (A container-level
//! `#[serde(default)]` would be simpler but specta-serde then exports every
//! field as optional.) Unknown fields are ignored.
//!
//! Payloads forwarded untouched stay `serde_json::Value` but are declared to
//! TypeScript as `unknown`: specta 2.0.0-rc.25 cannot export `Value` (it
//! expands the recursive type forever).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use specta_typescript::Unknown;

use crate::native::agent_config::AgentId;

fn null_as_empty<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct BuildInfo {
    pub version: String,
    pub commit: String,
    pub beacon_commit: String,
    pub go_version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct CaptureStatus {
    /// revoked | not_connected | paused_locally | paused_by_server | policy_stale | active
    pub state: String,
    pub local_paused: bool,
    pub unauthorized: bool,
    pub policy_cached: bool,
    pub policy_refreshed_at: Option<String>,
    pub policy_age_seconds: i64,
    pub policy_stale: bool,
    pub server_paused: bool,
    pub enabled_agents: Option<Vec<String>>,
    pub retention_days: Option<i32>,
    pub mappings: i32,
    /// API-only (contract v1.8); the CLI status omits it.
    pub auto_match_repos: bool,
    /// API-only (contract v1.8). A settings PATCH replaces the whole list.
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<String>)]
    pub exclude_globs: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentIntegration {
    pub state: String,
    pub config_path: String,
    #[serde(default)]
    pub problems: Vec<String>,
    /// The file each problem concerns, when not `config_path` alone (Codex).
    #[serde(default)]
    pub problem_config_paths: BTreeMap<String, String>,
    #[serde(default)]
    pub notes: Vec<String>,
    pub trust: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentStatus {
    pub id: String,
    pub state: String,
    pub installed: bool,
    pub configured: bool,
    pub receiving: bool,
    pub uploading: bool,
    pub paused: bool,
    pub broken: bool,
    pub last_observation_at: Option<String>,
    pub last_upload_at: Option<String>,
    pub integration: AgentIntegration,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct QueueStatus {
    pub records: i64,
    pub bytes: i64,
    pub failures: i64,
    pub next_attempt: String,
    pub last_error: Option<String>,
    pub acknowledged: i64,
    pub rejected: i64,
    pub dropped: i64,
    pub oldest_pending_at: Option<String>,
    pub inbox_items: i64,
    pub capacity_records: i64,
    pub capacity_bytes: i64,
    pub backing_off: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct DiscoveredProject {
    pub root: String,
    pub repo_url: Option<String>,
    #[serde(default)]
    pub unmatched: bool,
    pub first_seen: String,
    /// no_origin | not_bound | auto_match_off | excluded | ambiguous (projects endpoint only)
    pub reason: Option<String>,
    /// Filled for auto_match_off and ambiguous (contract v1.2); absent in status.
    #[serde(default)]
    pub candidates: Vec<BoardCandidate>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct BoardCandidate {
    pub workspace_id: String,
    pub workspace_name: String,
    pub board_id: String,
    pub board_name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct CompanionStatus {
    pub companion: BuildInfo,
    pub account: Option<AccountInfo>,
    pub connected: bool,
    pub revoked: bool,
    pub installation_id: String,
    pub endpoint: String,
    /// Every Backplane this device is connected to: at most one today,
    /// mirrored by the fields above. Absent from daemons that predate it.
    #[serde(default, deserialize_with = "null_as_empty")]
    #[specta(type = Vec<ConnectionStatus>)]
    pub connections: Vec<ConnectionStatus>,
    pub data_dir: String,
    pub daemon_running: bool,
    /// The service manager's view; null when it could not be asked.
    pub service: Option<ServiceStatus>,
    pub capture: CaptureStatus,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<AgentStatus>)]
    pub agents: Vec<AgentStatus>,
    pub queue: QueueStatus,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<DiscoveredProject>)]
    pub pending_projects: Vec<DiscoveredProject>,
    /// The computer's own name, for onboarding to prefill; null once
    /// connected. It reaches the server only as a name the user submits.
    pub suggested_device_name: Option<String>,
}

/// Defaulted field by field: a partial entry from an older or newer daemon
/// must never take the whole status down with it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct ConnectionStatus {
    pub installation_id: String,
    pub endpoint: String,
    pub connected: bool,
    pub revoked: bool,
    /// capture.state for this connection.
    pub capture_state: String,
    /// Absent from daemons that predate rich capture.
    pub rich_capture: Option<RichCaptureConnection>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct RichCaptureConnection {
    /// offered | not_offered (the server answered null) | unknown (no policy
    /// yet, or a server that predates rich capture)
    pub offer: String,
}

/// The LaunchAgent (or systemd/schtasks) service as the daemon sees it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ServiceStatus {
    pub backend: String,
    pub installed: bool,
    /// The definition matches what `service install` would write now.
    pub current: bool,
    pub enabled: bool,
    pub running: bool,
}

/// The installation owner, from the server's `GET /api/companion/me`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AccountInfo {
    pub email: String,
    pub display_name: Option<String>,
    /// The Backplane web app origin; `endpoint` is only the API origin.
    pub web_origin: Option<String>,
    /// The installation's name (contract v1.5).
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PauseState {
    pub paused: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct ProjectsOverview {
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<Unknown>)]
    pub mappings: Vec<Value>,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<DiscoveredProject>)]
    pub discovered: Vec<DiscoveredProject>,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<String>)]
    pub ignored: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentPresence {
    pub installed: bool,
    pub version: Option<String>,
    pub config_path: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentEntry {
    pub id: String,
    pub presence: Option<AgentPresence>,
    pub integration: Option<AgentIntegration>,
    pub action: Option<String>,
    pub telemetry: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct BoardSummary {
    pub id: String,
    pub name: String,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<String>)]
    pub repos: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct WorkspaceBoards {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<BoardSummary>)]
    pub boards: Vec<BoardSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct BoardsOverview {
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<WorkspaceBoards>)]
    pub workspaces: Vec<WorkspaceBoards>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionsQuery {
    pub status: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

/// Proxied verbatim from the server's `GET /api/companion/sessions`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct SessionsPage(#[specta(type = Unknown)] pub Value);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PairingTicket {
    pub pairing_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_at: String,
    pub interval: u32,
    /// The API endpoint the pairing runs against; only `GET /v1/pair`
    /// reports it (the approval page must be on its origin).
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PairingProgress {
    Pending,
    /// Approved; the daemon is storing the connection (a switch sends the old
    /// server its queue first). It can no longer be cancelled.
    Persisting,
    Connected {
        installation_id: String,
        /// Set when the pairing switched servers: whether the old server
        /// confirmed signing this device out.
        old_server_revoked: Option<bool>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PairingCancelled {
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct InstallationName {
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct DisconnectResult {
    pub connected: bool,
    pub server_revoked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct VersionReport {
    pub version: String,
    pub commit: String,
    pub beacon_commit: String,
    pub go_version: String,
    pub platform: String,
    #[specta(type = Unknown)]
    pub artifacts: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionTokens {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct LocalSession {
    pub native_session_id: String,
    pub harness: String,
    pub repo: Option<String>,
    /// The server id of the mapping that captured the session; null when unknown.
    pub mapping_id: Option<String>,
    pub started_at: Option<String>,
    pub last_event_at: Option<String>,
    pub tokens: Option<SessionTokens>,
    pub cost_estimated_usd: Option<f64>,
    /// spend | api_equivalent (contract v1.2); null when unknown.
    pub cost_basis: Option<String>,
    pub auth_kind: Option<String>,
    /// Why the session's earlier history is gone from Backplane: owner |
    /// retention | unknown; tokens then count only what came after. Null
    /// while it is intact, and from daemons that predate it.
    pub history_deleted: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SessionEvent {
    /// started | updated | ended
    pub kind: String,
    pub session: LocalSession,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AttentionItem {
    pub code: String,
    /// warning | error
    pub severity: String,
    pub agent: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct AttentionEvent {
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<AttentionItem>)]
    pub items: Vec<AttentionItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct PairingEvent {
    pub pairing_id: String,
    /// pending | connected | denied | expired | failed
    pub state: String,
}

/// What the shell forwards to the webview: the contract-A SSE events plus two
/// synthetic `daemon.*` states the shell derives from the socket itself.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "type", content = "data")]
pub enum DaemonStreamMessage {
    #[serde(rename = "daemon.connected")]
    Connected,
    #[serde(rename = "daemon.unreachable")]
    Unreachable { reason: String },
    #[serde(rename = "status")]
    Status(Box<CompanionStatus>),
    /// The `GET /v1/agents` shape (contract v1.3).
    #[serde(rename = "agents")]
    Agents(Vec<AgentEntry>),
    #[serde(rename = "projects")]
    Projects(#[specta(type = Unknown)] Value),
    #[serde(rename = "session")]
    Session(Box<SessionEvent>),
    #[serde(rename = "attention")]
    Attention(AttentionEvent),
    #[serde(rename = "policy.changed")]
    PolicyChanged,
    #[serde(rename = "pairing")]
    Pairing(PairingEvent),
    #[serde(rename = "agent_access")]
    AgentAccess(Box<AgentAccess>),
}

/// `GET /v1/agent-access` and the SSE `agent_access` event (contract v1.4 §A).
/// It carries no key material and no agent configuration values. Codes stay
/// strings: the UI has fixed words per known code and a generic fallback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentAccess {
    pub key: AgentKeyStatus,
    pub prerequisites: AgentPrerequisites,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<MappingAgentAccess>)]
    pub mappings: Vec<MappingAgentAccess>,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<AgentAccessWarning>)]
    pub warnings: Vec<AgentAccessWarning>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentKeyStatus {
    pub present: bool,
    pub key_prefix: Option<String>,
    /// active | missing (deleted on the web) | unknown
    pub server_state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentPrerequisites {
    pub uvx: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct MappingAgentAccess {
    pub mapping_id: String,
    pub enabled: bool,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<AgentAccessAgent>)]
    pub agents: Vec<AgentAccessAgent>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentAccessAgent {
    pub agent_id: String,
    /// folder | global
    pub scope: String,
    /// configured | pending | conflict | unsupported | error
    pub state: String,
    pub problem: Option<String>,
}

/// Another MCP entry an agent already has, named but never its values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentAccessWarning {
    pub agent_id: String,
    pub entry_name: String,
    /// mcp_name_taken | other_backplane_entry | same_endpoint
    pub reason: String,
}

/// `POST /v1/queue/flush` (contract v1.6): `reason` says why nothing was
/// scheduled (queue_empty | not_connected | device_revoked | daemon_not_running).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct QueueFlush {
    pub scheduled: bool,
    pub reason: Option<String>,
}

/// A device mapping, from the server's `MappingRead`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Mapping {
    pub id: String,
    pub workspace_id: String,
    pub board_id: Option<String>,
    /// Null for auto-matched repositories.
    pub root_path: Option<String>,
    pub repo_url_normalized: Option<String>,
    /// explicit | auto_repo
    pub origin: String,
    pub enabled: bool,
    /// metadata | standard | full | rich
    pub content_level: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct MappingCreate {
    pub workspace_id: String,
    pub board_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_url: Option<String>,
    pub content_level: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct MappingUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct DeletedMapping {
    pub deleted: String,
}

/// Distinguishes an absent member (`None`) from an explicit `null`
/// (`Some(None)`); serde's plain `Option` folds both into `None`.
fn present_or_null<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `PATCH /v1/settings`: only the members that are present are sent.
/// `enabled_agents`: absent leaves it, a list replaces it (`[]` disables
/// every agent). `null` is forwarded as is, but the daemon and the server
/// reject it (contract v1.7): to mean "every agent", send every daemon id.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Type)]
pub struct SettingsUpdate {
    #[serde(default)]
    pub auto_match_repos: Option<bool>,
    #[serde(default, deserialize_with = "present_or_null")]
    #[specta(optional, type = Option<Vec<AgentId>>)]
    pub enabled_agents: Option<Option<Vec<AgentId>>>,
    #[serde(default)]
    pub exclude_globs: Option<Vec<String>>,
}

impl SettingsUpdate {
    pub fn to_body(&self) -> Value {
        let mut body = serde_json::Map::new();
        if let Some(auto_match) = self.auto_match_repos {
            body.insert("auto_match_repos".into(), Value::Bool(auto_match));
        }
        if let Some(enabled_agents) = &self.enabled_agents {
            let value = match enabled_agents {
                None => Value::Null,
                Some(agents) => agents
                    .iter()
                    .map(|agent| Value::String(agent.as_str().into()))
                    .collect(),
            };
            body.insert("enabled_agents".into(), value);
        }
        if let Some(globs) = &self.exclude_globs {
            body.insert("exclude_globs".into(), serde_json::json!(globs));
        }
        Value::Object(body)
    }
}

/// The installation's capture settings, from the server's `CapturePolicy`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Settings {
    pub paused: bool,
    pub auto_match_repos: bool,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<String>)]
    pub enabled_agents: Vec<String>,
    #[serde(deserialize_with = "null_as_empty")]
    #[specta(type = Vec<String>)]
    pub exclude_globs: Vec<String>,
    pub retention_days: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct IgnoredProject {
    pub ignored: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UnignoredProject {
    pub unignored: String,
}

/// Proxied verbatim from the server's `GET /api/companion/sessions/{id}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct SessionDetail(#[specta(type = Unknown)] pub Value);

/// Proxied verbatim from the server's `GET /api/companion/sessions/{id}/usage`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct SessionUsage(#[specta(type = Unknown)] pub Value);

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS_FIXTURE: &str = include_str!("../../tests/fixtures/status.json");

    fn status_with(extra: &str) -> CompanionStatus {
        let mut fields: Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        let extra: Value = serde_json::from_str(extra).unwrap();
        fields
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(fields).unwrap()
    }

    #[test]
    fn status_carries_the_suggested_device_name() {
        let status = status_with(r#"{"suggested_device_name": "Ada’s MacBook Pro"}"#);
        assert_eq!(
            status.suggested_device_name.as_deref(),
            Some("Ada’s MacBook Pro")
        );
    }

    #[test]
    fn status_carries_each_connections_rich_capture_offer() {
        let status = status_with(
            r#"{"connections": [
                {"installation_id": "inst-1", "endpoint": "https://bp.example", "connected": true, "revoked": false, "capture_state": "active", "rich_capture": {"offer": "offered"}},
                {"installation_id": "inst-2", "endpoint": "https://old.example", "connected": true, "revoked": false, "capture_state": "active"}
            ]}"#,
        );
        assert_eq!(status.connections.len(), 2);
        assert_eq!(
            status.connections[0]
                .rich_capture
                .as_ref()
                .map(|rich| rich.offer.as_str()),
            Some("offered")
        );
        // A daemon that predates rich capture reports no offer state at all.
        assert_eq!(status.connections[1].rich_capture, None);
    }

    #[test]
    fn a_partial_connection_entry_still_decodes_the_status() {
        let status = status_with(r#"{"connections": [{"installation_id": "inst-1"}]}"#);
        assert_eq!(status.connections[0].installation_id, "inst-1");
        assert_eq!(status.connections[0].capture_state, "");
        assert_eq!(status.connections[0].rich_capture, None);
    }

    #[test]
    fn status_from_a_daemon_without_connections_decodes_empty() {
        assert!(status_with("{}").connections.is_empty());
        assert!(status_with(r#"{"connections": null}"#)
            .connections
            .is_empty());
    }

    #[test]
    fn status_without_a_suggestion_decodes_as_none() {
        assert_eq!(
            status_with(r#"{"suggested_device_name": null}"#).suggested_device_name,
            None
        );
        assert_eq!(status_with("{}").suggested_device_name, None);
    }
}
