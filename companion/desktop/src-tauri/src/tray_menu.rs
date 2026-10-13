// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The native right-click menu's text, derived from the daemon stream.

use crate::daemon::types::CompanionStatus;
use crate::opener::allowed_web_origin;

/// The DK-0 tray glyphs; each has a template PNG in icons/tray/.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayIconState {
    Capturing,
    Paused,
    Attention,
    Offline,
    Disconnected,
}

/// Agent states that need the user, per the DK-0 design.
const AGENT_PROBLEM_STATES: [&str; 3] = ["needs_trust", "broken", "invalid_config"];

/// DK-0 precedence: disconnected, offline, paused, attention, capturing.
pub fn tray_icon_state(
    daemon_connected: bool,
    status: Option<&CompanionStatus>,
    attention_items: usize,
) -> TrayIconState {
    let Some(status) = status.filter(|_| daemon_connected) else {
        return TrayIconState::Disconnected;
    };
    let capture = status.capture.state.as_str();
    if !status.connected || status.revoked || matches!(capture, "revoked" | "not_connected") {
        return TrayIconState::Disconnected;
    }
    if capture == "policy_stale" || status.queue.backing_off {
        return TrayIconState::Offline;
    }
    if capture.starts_with("paused") {
        return TrayIconState::Paused;
    }
    let agent_problem = status
        .agents
        .iter()
        .any(|agent| AGENT_PROBLEM_STATES.contains(&agent.state.as_str()));
    if attention_items > 0 || agent_problem {
        return TrayIconState::Attention;
    }
    TrayIconState::Capturing
}

pub fn tray_tooltip(state: TrayIconState) -> &'static str {
    match state {
        TrayIconState::Capturing => "Backplane Companion: capturing",
        TrayIconState::Paused => "Backplane Companion: paused",
        TrayIconState::Attention => "Backplane Companion: needs attention",
        TrayIconState::Offline => "Backplane Companion: can't reach Backplane",
        TrayIconState::Disconnected => "Backplane Companion: not connected",
    }
}

/// Where "Open Backplane" goes: the allowed web origin itself.
pub fn open_backplane_target(status: Option<&CompanionStatus>) -> Option<String> {
    allowed_web_origin(status).map(str::to_owned)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseAction {
    Pause,
    Resume,
}

pub fn tray_status_line(daemon_connected: bool, status: Option<&CompanionStatus>) -> String {
    if !daemon_connected {
        return "Companion isn't running".into();
    }
    let Some(status) = status else {
        return "Connecting to Companion…".into();
    };
    match status.capture.state.as_str() {
        "active" => "Capturing".into(),
        "paused_locally" => "Paused".into(),
        "paused_by_server" => "Paused by Backplane".into(),
        "policy_stale" => "Waiting for Backplane".into(),
        "not_connected" => "Not connected to Backplane".into(),
        "revoked" => "Device access revoked".into(),
        other => format!("Status: {other}"),
    }
}

/// "Connected to <host>" under the status line, so the server is visible
/// without opening Settings; the host people open (the web origin, else the
/// endpoint). None while not connected to one.
pub fn tray_server_line(
    daemon_connected: bool,
    status: Option<&CompanionStatus>,
) -> Option<String> {
    let status = status.filter(|status| daemon_connected && status.connected)?;
    let host = url::Url::parse(allowed_web_origin(Some(status))?)
        .ok()?
        .host_str()
        .map(str::to_owned)?;
    Some(format!("Connected to {host}"))
}

pub fn pause_action(status: Option<&CompanionStatus>) -> Option<PauseAction> {
    let status = status.filter(|status| status.connected)?;
    Some(if status.capture.local_paused {
        PauseAction::Resume
    } else {
        PauseAction::Pause
    })
}

pub fn pause_menu_label(action: Option<PauseAction>) -> &'static str {
    match action {
        Some(PauseAction::Resume) => "Resume capture",
        Some(PauseAction::Pause) | None => "Pause capture",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(capture_state: &str, local_paused: bool) -> CompanionStatus {
        let mut status = CompanionStatus {
            connected: true,
            ..Default::default()
        };
        status.capture.state = capture_state.into();
        status.capture.local_paused = local_paused;
        status
    }

    #[test]
    fn tray_status_line_reports_a_missing_daemon() {
        assert_eq!(tray_status_line(false, None), "Companion isn't running");
        assert_eq!(
            tray_status_line(false, Some(&status("active", false))),
            "Companion isn't running"
        );
    }

    #[test]
    fn tray_status_line_waits_for_the_first_status() {
        assert_eq!(tray_status_line(true, None), "Connecting to Companion…");
    }

    #[test]
    fn tray_status_line_names_each_capture_state() {
        let cases = [
            ("active", "Capturing"),
            ("paused_locally", "Paused"),
            ("paused_by_server", "Paused by Backplane"),
            ("policy_stale", "Waiting for Backplane"),
            ("not_connected", "Not connected to Backplane"),
            ("revoked", "Device access revoked"),
            ("something_new", "Status: something_new"),
        ];
        for (state, line) in cases {
            assert_eq!(
                tray_status_line(true, Some(&status(state, false))),
                line,
                "state={state}"
            );
        }
    }

    #[test]
    fn tray_server_line_names_the_connected_host() {
        let mut connected = status("active", false);
        connected.endpoint = "https://intern.example.dev/".into();
        assert_eq!(
            tray_server_line(true, Some(&connected)).as_deref(),
            Some("Connected to intern.example.dev")
        );
    }

    #[test]
    fn tray_server_line_names_the_web_origin_people_open() {
        let mut connected = status("active", false);
        connected.endpoint = "https://api.example.dev".into();
        connected.account = Some(crate::daemon::types::AccountInfo {
            email: "o@example.dev".into(),
            display_name: None,
            web_origin: Some("https://app.example.dev".into()),
            device_name: None,
        });
        assert_eq!(
            tray_server_line(true, Some(&connected)).as_deref(),
            Some("Connected to app.example.dev")
        );
    }

    #[test]
    fn tray_server_line_is_absent_without_a_connection() {
        let mut connected = status("active", false);
        connected.endpoint = "https://intern.example.dev".into();
        assert_eq!(tray_server_line(false, Some(&connected)), None);
        assert_eq!(tray_server_line(true, None), None);
        let mut signed_out = connected.clone();
        signed_out.connected = false;
        assert_eq!(tray_server_line(true, Some(&signed_out)), None);
        let mut unparsable = connected;
        unparsable.endpoint = String::new();
        assert_eq!(tray_server_line(true, Some(&unparsable)), None);
    }

    #[test]
    fn pause_action_offers_resume_only_when_paused_locally() {
        assert_eq!(
            pause_action(Some(&status("paused_locally", true))),
            Some(PauseAction::Resume)
        );
        assert_eq!(
            pause_action(Some(&status("active", false))),
            Some(PauseAction::Pause)
        );
    }

    #[test]
    fn pause_action_is_unavailable_without_a_connected_status() {
        assert_eq!(pause_action(None), None);
        let disconnected = CompanionStatus::default();
        assert_eq!(pause_action(Some(&disconnected)), None);
    }

    #[test]
    fn pause_menu_label_matches_the_action() {
        assert_eq!(pause_menu_label(Some(PauseAction::Pause)), "Pause capture");
        assert_eq!(
            pause_menu_label(Some(PauseAction::Resume)),
            "Resume capture"
        );
        assert_eq!(pause_menu_label(None), "Pause capture");
    }

    fn capturing() -> CompanionStatus {
        let mut status = status("active", false);
        status.agents = vec![crate::daemon::types::AgentStatus {
            id: "claude".into(),
            state: "receiving".into(),
            ..Default::default()
        }];
        status
    }

    #[test]
    fn tray_icon_state_is_disconnected_without_a_daemon_or_status() {
        assert_eq!(
            tray_icon_state(false, Some(&capturing()), 0),
            TrayIconState::Disconnected
        );
        assert_eq!(tray_icon_state(true, None, 0), TrayIconState::Disconnected);
    }

    #[test]
    fn tray_icon_state_is_disconnected_when_not_paired_or_revoked() {
        for state in ["not_connected", "revoked"] {
            assert_eq!(
                tray_icon_state(true, Some(&status(state, false)), 0),
                TrayIconState::Disconnected,
                "{state}"
            );
        }
        let mut unpaired = capturing();
        unpaired.connected = false;
        assert_eq!(
            tray_icon_state(true, Some(&unpaired), 0),
            TrayIconState::Disconnected
        );
    }

    #[test]
    fn tray_icon_state_is_offline_when_backplane_is_unreachable() {
        assert_eq!(
            tray_icon_state(true, Some(&status("policy_stale", false)), 0),
            TrayIconState::Offline
        );
        let mut backing_off = capturing();
        backing_off.queue.backing_off = true;
        assert_eq!(
            tray_icon_state(true, Some(&backing_off), 0),
            TrayIconState::Offline
        );
    }

    #[test]
    fn tray_icon_state_is_paused_for_local_and_server_pauses() {
        assert_eq!(
            tray_icon_state(true, Some(&status("paused_locally", true)), 3),
            TrayIconState::Paused
        );
        assert_eq!(
            tray_icon_state(true, Some(&status("paused_by_server", false)), 0),
            TrayIconState::Paused
        );
    }

    #[test]
    fn tray_icon_state_needs_attention_for_attention_items_or_agent_problems() {
        assert_eq!(
            tray_icon_state(true, Some(&capturing()), 1),
            TrayIconState::Attention
        );
        for problem in ["needs_trust", "broken", "invalid_config"] {
            let mut status = capturing();
            status.agents[0].state = problem.into();
            assert_eq!(
                tray_icon_state(true, Some(&status), 0),
                TrayIconState::Attention,
                "{problem}"
            );
        }
    }

    #[test]
    fn tray_icon_state_is_capturing_when_active_and_healthy() {
        let mut idle = capturing();
        idle.agents[0].state = "not_installed".into();
        assert_eq!(
            tray_icon_state(true, Some(&idle), 0),
            TrayIconState::Capturing
        );
        assert_eq!(
            tray_icon_state(true, Some(&capturing()), 0),
            TrayIconState::Capturing
        );
    }

    #[test]
    fn open_backplane_target_uses_the_web_origin() {
        let mut status = capturing();
        status.endpoint = "https://api.example.dev".into();
        status.account = Some(crate::daemon::types::AccountInfo {
            email: "o@example.dev".into(),
            display_name: None,
            web_origin: Some("https://app.example.dev".into()),
            device_name: None,
        });
        assert_eq!(
            open_backplane_target(Some(&status)).as_deref(),
            Some("https://app.example.dev")
        );
    }

    #[test]
    fn open_backplane_target_is_none_when_not_connected() {
        assert_eq!(open_backplane_target(None), None);
        assert_eq!(
            open_backplane_target(Some(&CompanionStatus::default())),
            None
        );
    }

    #[test]
    fn tray_tooltip_names_every_state() {
        assert_eq!(
            tray_tooltip(TrayIconState::Offline),
            "Backplane Companion: can't reach Backplane"
        );
        assert_eq!(
            tray_tooltip(TrayIconState::Disconnected),
            "Backplane Companion: not connected"
        );
    }
}
