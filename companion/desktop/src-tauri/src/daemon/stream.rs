// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use std::time::Duration;

use super::backoff::Backoff;
use super::sse::{SseEvent, SseParser};
use super::types::DaemonStreamMessage;
use super::{DaemonClient, DaemonError};

#[derive(Debug, Clone)]
pub struct StreamConfig {
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    /// The daemon pings every 15 s; three missed pings mean a wedged stream.
    pub idle_timeout: Duration,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            initial_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(45),
        }
    }
}

pub fn decode_stream_event(event: &SseEvent) -> Option<DaemonStreamMessage> {
    let data = event.data.as_str();
    let decoded =
        match event.event.as_str() {
            "status" => serde_json::from_str(data)
                .map(|status| DaemonStreamMessage::Status(Box::new(status))),
            "agents" => serde_json::from_str(data).map(DaemonStreamMessage::Agents),
            "projects" => serde_json::from_str(data).map(DaemonStreamMessage::Projects),
            "session" => serde_json::from_str(data)
                .map(|event| DaemonStreamMessage::Session(Box::new(event))),
            "attention" => serde_json::from_str(data).map(DaemonStreamMessage::Attention),
            "pairing" => serde_json::from_str(data).map(DaemonStreamMessage::Pairing),
            "agent_access" => serde_json::from_str(data)
                .map(|access| DaemonStreamMessage::AgentAccess(Box::new(access))),
            "policy.changed" => Ok(DaemonStreamMessage::PolicyChanged),
            _ => return None,
        };
    match decoded {
        Ok(message) => Some(message),
        Err(error) => {
            log::warn!("dropping malformed {} event: {error}", event.event);
            None
        }
    }
}

fn unreachable_reason(error: &DaemonError) -> String {
    match error {
        DaemonError::Unreachable { reason } => reason.clone(),
        DaemonError::Api { code, .. } => code.clone(),
        DaemonError::Timeout => "timeout".into(),
        DaemonError::ResponseTooLarge { .. } => "response_too_large".into(),
        DaemonError::Protocol { .. }
        | DaemonError::InvalidInput { .. }
        | DaemonError::Local { .. } => "protocol_error".into(),
    }
}

/// Runs until the task is aborted: forwards every decoded event, reconnects
/// with backoff, and reports `daemon.unreachable` once per distinct reason.
pub async fn run_event_stream<F>(client: DaemonClient, config: StreamConfig, sink: F)
where
    F: Fn(DaemonStreamMessage) + Send + Sync + 'static,
{
    let mut backoff = Backoff::new(config.initial_backoff, config.max_backoff);
    let mut reported_outage: Option<String> = None;
    loop {
        let mut stream = match client.open_event_stream().await {
            Ok(stream) => stream,
            Err(error) => {
                let reason = unreachable_reason(&error);
                if reported_outage.as_deref() != Some(reason.as_str()) {
                    sink(DaemonStreamMessage::Unreachable {
                        reason: reason.clone(),
                    });
                    reported_outage = Some(reason);
                }
                tokio::time::sleep(backoff.next_delay()).await;
                continue;
            }
        };
        reported_outage = None;
        sink(DaemonStreamMessage::Connected);

        let mut parser = SseParser::default();
        let mut delivered_any_event = false;
        let mut overflowed = false;
        while let Ok(Some(Ok(chunk))) =
            tokio::time::timeout(config.idle_timeout, stream.next_chunk()).await
        {
            let Ok(events) = parser.push(&chunk) else {
                log::warn!("dropping the daemon event stream: an event exceeded the size cap");
                overflowed = true;
                break;
            };
            for event in events {
                delivered_any_event = true;
                if let Some(message) = decode_stream_event(&event) {
                    sink(message);
                }
            }
        }
        // A daemon that drops a slow client expects an immediate reconnect; one
        // that accepts and closes without a single event must not be hot-looped.
        if delivered_any_event && !overflowed {
            backoff.reset();
        } else {
            tokio::time::sleep(backoff.next_delay()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATUS_FIXTURE: &str = include_str!("../../tests/fixtures/status.json");

    fn sse(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: event.into(),
            data: data.into(),
        }
    }

    #[test]
    fn decode_stream_event_maps_status() {
        let message = decode_stream_event(&sse("status", STATUS_FIXTURE));
        let Some(DaemonStreamMessage::Status(status)) = message else {
            panic!("expected status")
        };
        assert!(status.connected);
        assert_eq!(status.capture.state, "active");
        assert_eq!(
            status.agents[1].integration.problems,
            vec!["hooks disabled".to_string()]
        );
        assert_eq!(status.queue.records, 4);
        assert_eq!(
            status.pending_projects[0].repo_url.as_deref(),
            Some("github.com/acme/app")
        );
    }

    #[test]
    fn decode_stream_event_accepts_null_lists_from_go() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["agents"] = serde_json::Value::Null;
        document["pending_projects"] = serde_json::Value::Null;
        let message = decode_stream_event(&sse("status", &document.to_string()));
        let Some(DaemonStreamMessage::Status(status)) = message else {
            panic!("expected status")
        };
        assert!(status.agents.is_empty() && status.pending_projects.is_empty());
    }

    #[test]
    fn decode_stream_event_maps_the_capture_settings_and_device_name() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["account"]["device_name"] = "Tester’s laptop".into();
        let message = decode_stream_event(&sse("status", &document.to_string()));
        let Some(DaemonStreamMessage::Status(status)) = message else {
            panic!("expected status")
        };
        assert!(status.capture.auto_match_repos);
        assert_eq!(
            status.capture.exclude_globs,
            vec!["**/secrets/**".to_string()]
        );
        assert_eq!(
            status
                .account
                .and_then(|account| account.device_name)
                .as_deref(),
            Some("Tester’s laptop")
        );
    }

    #[test]
    fn decode_stream_event_treats_null_exclude_globs_and_a_missing_device_name_as_empty() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["capture"]["exclude_globs"] = serde_json::Value::Null;
        let Some(DaemonStreamMessage::Status(status)) =
            decode_stream_event(&sse("status", &document.to_string()))
        else {
            panic!("expected status")
        };
        assert!(status.capture.exclude_globs.is_empty());
        assert_eq!(status.account.unwrap().device_name, None);
    }

    #[test]
    fn decode_stream_event_skips_a_status_without_auto_match_repos() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["capture"]
            .as_object_mut()
            .unwrap()
            .remove("auto_match_repos");
        assert_eq!(
            decode_stream_event(&sse("status", &document.to_string())),
            None
        );
    }

    #[test]
    fn decode_stream_event_types_the_service_and_accepts_null() {
        let Some(DaemonStreamMessage::Status(status)) =
            decode_stream_event(&sse("status", STATUS_FIXTURE))
        else {
            panic!("expected status")
        };
        let service = status.service.expect("the fixture has a service");
        assert_eq!(service.backend, "launchd");
        assert!(service.installed && service.current && service.enabled && service.running);
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["service"] = serde_json::Value::Null;
        let Some(DaemonStreamMessage::Status(status)) =
            decode_stream_event(&sse("status", &document.to_string()))
        else {
            panic!("expected status")
        };
        assert_eq!(status.service, None);
    }

    #[test]
    fn decode_stream_event_skips_a_status_missing_required_fields() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document.as_object_mut().unwrap().remove("capture");
        assert_eq!(
            decode_stream_event(&sse("status", &document.to_string())),
            None
        );
    }

    #[test]
    fn decode_stream_event_maps_attention_session_pairing_and_policy() {
        assert!(matches!(
            decode_stream_event(&sse(
                "attention",
                r#"{"items":[{"code":"hook_errors","severity":"warning","agent":null,"message":"m"}]}"#
            )),
            Some(DaemonStreamMessage::Attention(_))
        ));
        assert!(matches!(
            decode_stream_event(&sse(
                "session",
                r#"{"kind":"started","session":{"native_session_id":"s1","harness":"claude"}}"#
            )),
            Some(DaemonStreamMessage::Session(_))
        ));
        assert!(matches!(
            decode_stream_event(&sse(
                "pairing",
                r#"{"pairing_id":"p1","state":"connected"}"#
            )),
            Some(DaemonStreamMessage::Pairing(_))
        ));
        assert_eq!(
            decode_stream_event(&sse("policy.changed", "{}")),
            Some(DaemonStreamMessage::PolicyChanged)
        );
        assert_eq!(
            decode_stream_event(&sse("agents", "[]")),
            Some(DaemonStreamMessage::Agents(vec![]))
        );
        assert!(matches!(
            decode_stream_event(&sse("projects", r#"{"mappings":[]}"#)),
            Some(DaemonStreamMessage::Projects(_))
        ));
    }

    #[test]
    fn decode_stream_event_keeps_the_session_mapping_id_and_tolerates_its_absence() {
        let with_mapping = r#"{"kind":"started","session":{"native_session_id":"s1","harness":"claude","mapping_id":"m1"}}"#;
        let Some(DaemonStreamMessage::Session(event)) =
            decode_stream_event(&sse("session", with_mapping))
        else {
            panic!("expected a session");
        };
        assert_eq!(event.session.mapping_id.as_deref(), Some("m1"));

        let without_mapping = r#"{"kind":"started","session":{"native_session_id":"s1","harness":"claude","mapping_id":null}}"#;
        let Some(DaemonStreamMessage::Session(event)) =
            decode_stream_event(&sse("session", without_mapping))
        else {
            panic!("expected a session");
        };
        assert_eq!(event.session.mapping_id, None);
    }

    #[test]
    fn decode_stream_event_types_agents_with_the_agents_endpoint_shape() {
        let data = r#"[{"id":"claude","presence":{"installed":true,"version":"2.1.0","config_path":"/h/.claude/settings.json"},"integration":{"state":"installed","config_path":"/h/.claude/settings.json"}}]"#;
        let Some(DaemonStreamMessage::Agents(agents)) = decode_stream_event(&sse("agents", data))
        else {
            panic!("expected agents");
        };
        assert_eq!(agents[0].id, "claude");
        assert_eq!(
            agents[0]
                .presence
                .as_ref()
                .and_then(|p| p.version.as_deref()),
            Some("2.1.0")
        );
    }

    #[test]
    fn decode_stream_event_skips_agents_without_an_id() {
        assert_eq!(
            decode_stream_event(&sse("agents", r#"[{"presence":null}]"#)),
            None
        );
    }

    #[test]
    fn decode_stream_event_reads_the_account_and_ignores_unknown_fields() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["account"]["future_field"] = serde_json::json!(true);
        document["brand_new_top_level"] = serde_json::json!({"x": 1});
        let Some(DaemonStreamMessage::Status(status)) =
            decode_stream_event(&sse("status", &document.to_string()))
        else {
            panic!("expected status");
        };
        let account = status.account.expect("account");
        assert_eq!(
            account.web_origin.as_deref(),
            Some("https://app.bp.example.dev")
        );
        assert_eq!(account.display_name, None);
    }

    #[test]
    fn decode_stream_event_accepts_a_null_account() {
        let mut document: serde_json::Value = serde_json::from_str(STATUS_FIXTURE).unwrap();
        document["account"] = serde_json::Value::Null;
        let Some(DaemonStreamMessage::Status(status)) =
            decode_stream_event(&sse("status", &document.to_string()))
        else {
            panic!("expected status");
        };
        assert_eq!(status.account, None);
    }

    const AGENT_ACCESS: &str = r#"{"key":{"present":true,"key_prefix":"vlr_ab12","server_state":"active"},"prerequisites":{"uvx":true},"mappings":[{"mapping_id":"m1","enabled":true,"agents":[{"agent_id":"claude_code","scope":"folder","state":"configured","problem":null},{"agent_id":"codex_cli","scope":"global","state":"configured","problem":"restart_required"}]}],"warnings":[{"agent_id":"codex_cli","entry_name":"valaris","reason":"same_endpoint"}]}"#;

    #[test]
    fn decode_stream_event_maps_agent_access() {
        let Some(DaemonStreamMessage::AgentAccess(access)) =
            decode_stream_event(&sse("agent_access", AGENT_ACCESS))
        else {
            panic!("expected agent_access")
        };
        assert!(access.key.present && access.prerequisites.uvx);
        assert_eq!(access.key.server_state, "active");
        let mapping = &access.mappings[0];
        assert_eq!((mapping.mapping_id.as_str(), mapping.enabled), ("m1", true));
        assert_eq!(
            mapping.agents[1].problem.as_deref(),
            Some("restart_required")
        );
        assert_eq!(access.warnings[0].entry_name, "valaris");
    }

    #[test]
    fn decode_stream_event_accepts_null_agent_access_lists_from_go() {
        let data = r#"{"key":{"present":false,"key_prefix":null,"server_state":"unknown"},"prerequisites":{"uvx":false},"mappings":[{"mapping_id":"m1","enabled":false,"agents":null}],"warnings":null}"#;
        let Some(DaemonStreamMessage::AgentAccess(access)) =
            decode_stream_event(&sse("agent_access", data))
        else {
            panic!("expected agent_access")
        };
        assert!(access.warnings.is_empty() && access.mappings[0].agents.is_empty());
    }

    #[test]
    fn decode_stream_event_skips_agent_access_without_its_key_state() {
        assert_eq!(
            decode_stream_event(&sse("agent_access", r#"{"mappings":[],"warnings":[]}"#)),
            None
        );
    }

    #[test]
    fn decode_stream_event_skips_unknown_event_types() {
        assert_eq!(decode_stream_event(&sse("future.thing", "{}")), None);
    }

    #[test]
    fn decode_stream_event_skips_malformed_json() {
        assert_eq!(decode_stream_event(&sse("status", "{nope")), None);
    }

    #[test]
    fn decode_stream_event_never_synthesizes_daemon_states_from_the_wire() {
        assert_eq!(
            decode_stream_event(&sse("daemon.unreachable", r#"{"reason":"x"}"#)),
            None
        );
        assert_eq!(decode_stream_event(&sse("daemon.connected", "{}")), None);
    }
}
