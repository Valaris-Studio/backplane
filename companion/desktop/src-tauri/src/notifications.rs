// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Native notifications from fixed templates (contract D). Only agent display
//! names are ever interpolated: no prompts, paths, repo names or daemon text.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use crate::daemon::hub::EventHub;
use crate::daemon::types::{AttentionEvent, CompanionStatus, DaemonStreamMessage};
use crate::update::flow::LaunchOutcome;

/// A broken agent often recovers on its own (a restart, a transient upload
/// failure); only a condition that outlasts this is worth interrupting for.
pub const AGENT_BROKEN_DEBOUNCE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Condition {
    DeviceRevoked,
    PausedByServer,
    AgentBroken(String),
    NeedsTrust(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    DeviceRevoked,
    AgentBroken { agent_name: &'static str },
    NeedsTrust { agent_name: &'static str },
    PausedByServer,
    CaptureRepaired,
    UpdateRolledBack,
}

impl Notice {
    pub fn title(&self) -> String {
        match self {
            Self::DeviceRevoked => "Companion was disconnected".into(),
            Self::AgentBroken { agent_name } => format!("{agent_name} capture stopped working"),
            Self::NeedsTrust { agent_name } => format!("{agent_name} needs your approval"),
            Self::PausedByServer => "Capture paused by Backplane".into(),
            Self::CaptureRepaired => "Capture repaired".into(),
            Self::UpdateRolledBack => "Update failed".into(),
        }
    }

    pub fn body(&self) -> String {
        match self {
            Self::DeviceRevoked => {
                "This device was removed from Backplane. Open Companion to connect it again.".into()
            }
            Self::AgentBroken { .. } => {
                "Sessions have not been captured for 5 minutes. Open Companion to see what needs fixing."
                    .into()
            }
            Self::NeedsTrust { agent_name } => {
                format!("Trust the Backplane hooks in {agent_name} to start capturing its sessions.")
            }
            Self::PausedByServer => {
                "Backplane paused capture for this device. Nothing is sent until it resumes.".into()
            }
            Self::CaptureRepaired => {
                "Companion moved with the app, and capture points at the new location.".into()
            }
            Self::UpdateRolledBack => {
                "Companion could not install the update and went back to the previous version.".into()
            }
        }
    }
}

/// Only these names ever reach a notification; any other id reads as a
/// generic agent so daemon-supplied text never becomes notification content.
pub fn agent_display_name(agent_id: &str) -> &'static str {
    match agent_id {
        "claude_code" => "Claude Code",
        "codex_cli" => "Codex",
        "pi_cli" => "Pi",
        _ => "An agent",
    }
}

pub trait Clock: Send {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

pub trait Notifier: Send {
    fn notify(&self, notice: &Notice);
}

/// Conditions come from the latest `status` and the latest `attention` event;
/// a condition resolves only once neither reports it. A daemon outage changes
/// neither, so reconnecting never repeats a notification.
pub struct NotificationEngine<C: Clock, N: Notifier> {
    clock: C,
    notifier: N,
    enabled: Arc<AtomicBool>,
    from_status: HashSet<Condition>,
    from_attention: HashSet<Condition>,
    /// From the latest status; None until one arrives.
    device_connected: Option<bool>,
    /// Agents whose only problems are hooks pointing at another copy of the
    /// app: Repair fixes it, and capture has not necessarily stopped.
    stale_only_agents: HashSet<String>,
    /// Set by the webview while onboarding shows; it walks the agents itself.
    onboarding_active: bool,
    active_since: HashMap<Condition, Instant>,
    /// Notified, or suppressed because notifications were off when it became
    /// due; either way it stays quiet until it resolves.
    handled: HashSet<Condition>,
}

impl<C: Clock, N: Notifier> NotificationEngine<C, N> {
    pub fn new(clock: C, notifier: N, enabled: Arc<AtomicBool>) -> Self {
        Self {
            clock,
            notifier,
            enabled,
            from_status: HashSet::new(),
            from_attention: HashSet::new(),
            device_connected: None,
            stale_only_agents: HashSet::new(),
            onboarding_active: false,
            active_since: HashMap::new(),
            handled: HashSet::new(),
        }
    }

    pub fn observe(&mut self, message: &DaemonStreamMessage) {
        match message {
            DaemonStreamMessage::Status(status) => {
                self.from_status = status_conditions(status);
                self.device_connected = Some(status.connected);
                self.stale_only_agents = stale_only_agents(status);
            }
            DaemonStreamMessage::Attention(attention) => {
                self.from_attention = attention_conditions(attention)
            }
            _ => return,
        }
        self.evaluate();
    }

    pub fn set_onboarding_active(&mut self, active: bool) {
        self.onboarding_active = active;
        self.evaluate();
    }

    /// Before pairing and during onboarding an agent's state is the setup
    /// flow's business; a stale older install must not interrupt it.
    fn agent_notices_held(&self) -> bool {
        self.onboarding_active || self.device_connected == Some(false)
    }

    fn counts(&self, condition: &Condition) -> bool {
        match condition {
            Condition::AgentBroken(agent) => {
                !self.agent_notices_held() && !self.stale_only_agents.contains(agent)
            }
            Condition::NeedsTrust(_) => !self.agent_notices_held(),
            Condition::DeviceRevoked | Condition::PausedByServer => true,
        }
    }

    /// Called periodically so a debounced condition fires without a new event.
    pub fn tick(&mut self) {
        self.evaluate();
    }

    pub fn capture_repaired(&mut self) {
        self.send(&Notice::CaptureRepaired);
    }

    pub fn update_rolled_back(&mut self) {
        self.send(&Notice::UpdateRolledBack);
    }

    pub fn observe_launch_outcome(&mut self, outcome: &LaunchOutcome) {
        observe_launch_outcome(self, outcome);
    }

    fn evaluate(&mut self) {
        let now = self.clock.now();
        // A held condition is not tracked at all, so its debounce starts once the hold ends.
        let active: HashSet<Condition> = self
            .from_status
            .union(&self.from_attention)
            .filter(|condition| self.counts(condition))
            .cloned()
            .collect();
        self.active_since
            .retain(|condition, _| active.contains(condition));
        self.handled.retain(|condition| active.contains(condition));

        let mut due: Vec<Condition> = Vec::new();
        for condition in active {
            let since = *self.active_since.entry(condition.clone()).or_insert(now);
            if self.handled.contains(&condition) {
                continue;
            }
            let debounce = match condition {
                Condition::AgentBroken(_) => AGENT_BROKEN_DEBOUNCE,
                _ => Duration::ZERO,
            };
            if now.saturating_duration_since(since) >= debounce {
                due.push(condition);
            }
        }
        for condition in due {
            self.send(&notice_for(&condition));
            self.handled.insert(condition);
        }
    }

    fn send(&self, notice: &Notice) {
        if self.enabled.load(Ordering::SeqCst) {
            self.notifier.notify(notice);
        }
    }
}

fn notice_for(condition: &Condition) -> Notice {
    match condition {
        Condition::DeviceRevoked => Notice::DeviceRevoked,
        Condition::PausedByServer => Notice::PausedByServer,
        Condition::AgentBroken(agent) => Notice::AgentBroken {
            agent_name: agent_display_name(agent),
        },
        Condition::NeedsTrust(agent) => Notice::NeedsTrust {
            agent_name: agent_display_name(agent),
        },
    }
}

const NEEDS_TRUST: &str = "needs_trust";

fn status_conditions(status: &CompanionStatus) -> HashSet<Condition> {
    let mut conditions = HashSet::new();
    if status.revoked || status.capture.state == "revoked" {
        conditions.insert(Condition::DeviceRevoked);
    }
    if status.capture.server_paused || status.capture.state == "paused_by_server" {
        conditions.insert(Condition::PausedByServer);
    }
    for agent in &status.agents {
        if agent.broken {
            conditions.insert(Condition::AgentBroken(agent.id.clone()));
        }
        if agent.state == NEEDS_TRUST || agent.integration.state == NEEDS_TRUST {
            conditions.insert(Condition::NeedsTrust(agent.id.clone()));
        }
    }
    conditions
}

const STALE_SUFFIX: &str = ":stale";

fn stale_only_agents(status: &CompanionStatus) -> HashSet<String> {
    status
        .agents
        .iter()
        .filter(|agent| {
            let problems = &agent.integration.problems;
            !problems.is_empty()
                && problems
                    .iter()
                    .all(|problem| problem.ends_with(STALE_SUFFIX))
        })
        .map(|agent| agent.id.clone())
        .collect()
}

fn attention_conditions(attention: &AttentionEvent) -> HashSet<Condition> {
    attention
        .items
        .iter()
        .filter_map(|item| match (item.code.as_str(), &item.agent) {
            ("device_revoked", _) => Some(Condition::DeviceRevoked),
            ("agent_broken", Some(agent)) => Some(Condition::AgentBroken(agent.clone())),
            (NEEDS_TRUST, Some(agent)) => Some(Condition::NeedsTrust(agent.clone())),
            _ => None,
        })
        .collect()
}

/// DK-11's launch-time update check reports here; only a rollback notifies.
pub fn observe_launch_outcome<C: Clock, N: Notifier>(
    engine: &mut NotificationEngine<C, N>,
    outcome: &LaunchOutcome,
) {
    if matches!(outcome, LaunchOutcome::RolledBack { .. }) {
        engine.update_rolled_back();
    }
}

/// Shows a notice as a macOS notification; delivery happens off this thread.
pub struct TauriNotifier(tauri::AppHandle);

impl Notifier for TauriNotifier {
    fn notify(&self, notice: &Notice) {
        use tauri_plugin_notification::NotificationExt;
        let shown = self
            .0
            .notification()
            .builder()
            .title(notice.title())
            .body(notice.body())
            .show();
        if let Err(error) = shown {
            log::warn!("a notification could not be shown: {error}");
        }
    }
}

pub type SharedEngine = Arc<Mutex<NotificationEngine<SystemClock, TauriNotifier>>>;

const HUB_SUBSCRIBER_KEY: &str = "notifications";
/// Resolution for the agent-broken debounce; well under its five minutes.
const TICK_INTERVAL: Duration = Duration::from_secs(30);

pub fn lock_engine<C: Clock, N: Notifier>(
    engine: &Mutex<NotificationEngine<C, N>>,
) -> MutexGuard<'_, NotificationEngine<C, N>> {
    engine.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Subscribes to the event hub (which replays the current status at once)
/// and ticks the debounce clock for the life of the app.
pub fn start(app: &tauri::AppHandle, hub: &EventHub, enabled: Arc<AtomicBool>) -> SharedEngine {
    let engine: SharedEngine = Arc::new(Mutex::new(NotificationEngine::new(
        SystemClock,
        TauriNotifier(app.clone()),
        enabled,
    )));
    let observer = engine.clone();
    hub.subscribe(
        HUB_SUBSCRIBER_KEY,
        Box::new(move |message| {
            lock_engine(&observer).observe(message);
            true
        }),
    );
    let ticker = engine.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        loop {
            interval.tick().await;
            lock_engine(&ticker).tick();
        }
    });
    engine
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::types::{AgentIntegration, AgentStatus, AttentionItem};

    #[derive(Clone)]
    struct FakeClock(Arc<Mutex<Instant>>);

    impl FakeClock {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(Instant::now())))
        }
        fn advance(&self, by: Duration) {
            *self.0.lock().unwrap() += by;
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            *self.0.lock().unwrap()
        }
    }

    #[derive(Clone, Default)]
    struct FakeNotifier(Arc<Mutex<Vec<Notice>>>);

    impl FakeNotifier {
        fn sent(&self) -> Vec<Notice> {
            self.0.lock().unwrap().clone()
        }
    }

    impl Notifier for FakeNotifier {
        fn notify(&self, notice: &Notice) {
            self.0.lock().unwrap().push(notice.clone());
        }
    }

    struct Harness {
        clock: FakeClock,
        notifier: FakeNotifier,
        enabled: Arc<AtomicBool>,
        engine: NotificationEngine<FakeClock, FakeNotifier>,
    }

    fn harness() -> Harness {
        let clock = FakeClock::new();
        let notifier = FakeNotifier::default();
        let enabled = Arc::new(AtomicBool::new(true));
        let engine = NotificationEngine::new(clock.clone(), notifier.clone(), enabled.clone());
        Harness {
            clock,
            notifier,
            enabled,
            engine,
        }
    }

    fn healthy() -> CompanionStatus {
        let mut status = CompanionStatus {
            connected: true,
            ..CompanionStatus::default()
        };
        status.capture.state = "active".into();
        status
    }

    fn with_agent(
        mut status: CompanionStatus,
        id: &str,
        broken: bool,
        state: &str,
    ) -> CompanionStatus {
        status.agents.push(AgentStatus {
            id: id.into(),
            state: state.into(),
            broken,
            integration: AgentIntegration {
                state: state.into(),
                config_path: "/home/someone/.claude/settings.json".into(),
                ..AgentIntegration::default()
            },
            ..AgentStatus::default()
        });
        status
    }

    fn revoked() -> CompanionStatus {
        let mut status = healthy();
        status.revoked = true;
        status.capture.state = "revoked".into();
        status
    }

    fn paused_by_server() -> CompanionStatus {
        let mut status = healthy();
        status.capture.server_paused = true;
        status.capture.state = "paused_by_server".into();
        status
    }

    fn status(status: CompanionStatus) -> DaemonStreamMessage {
        DaemonStreamMessage::Status(Box::new(status))
    }

    fn attention(items: Vec<(&str, Option<&str>)>) -> DaemonStreamMessage {
        DaemonStreamMessage::Attention(AttentionEvent {
            items: items
                .into_iter()
                .map(|(code, agent)| AttentionItem {
                    code: code.into(),
                    severity: "warning".into(),
                    agent: agent.map(Into::into),
                    message: "Run /hooks in /home/someone/secret-repo".into(),
                })
                .collect(),
        })
    }

    #[test]
    fn device_revoked_notifies_once_until_it_resolves() {
        let mut h = harness();
        h.engine.observe(&status(revoked()));
        h.engine.observe(&status(revoked()));
        h.engine.tick();
        assert_eq!(h.notifier.sent(), vec![Notice::DeviceRevoked]);
        h.engine.observe(&status(healthy()));
        h.engine.observe(&status(revoked()));
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::DeviceRevoked, Notice::DeviceRevoked]
        );
    }

    #[test]
    fn device_revoked_is_also_read_from_the_attention_stream() {
        let mut h = harness();
        h.engine.observe(&attention(vec![("device_revoked", None)]));
        assert_eq!(h.notifier.sent(), vec![Notice::DeviceRevoked]);
    }

    #[test]
    fn a_healthy_status_notifies_nothing() {
        let mut h = harness();
        h.engine.observe(&DaemonStreamMessage::Connected);
        h.engine.observe(&status(with_agent(
            healthy(),
            "claude_code",
            false,
            "uploading",
        )));
        h.engine.observe(&attention(vec![]));
        h.clock.advance(Duration::from_secs(3600));
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn paused_by_server_notifies_once_until_resumed() {
        let mut h = harness();
        h.engine.observe(&status(paused_by_server()));
        h.engine.observe(&status(paused_by_server()));
        assert_eq!(h.notifier.sent(), vec![Notice::PausedByServer]);
        h.engine.observe(&status(healthy()));
        h.engine.observe(&status(paused_by_server()));
        assert_eq!(h.notifier.sent().len(), 2);
    }

    #[test]
    fn a_locally_paused_device_is_not_paused_by_the_server() {
        let mut h = harness();
        let mut local = healthy();
        local.capture.local_paused = true;
        local.capture.state = "paused_locally".into();
        h.engine.observe(&status(local));
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn agent_broken_waits_five_minutes_before_notifying() {
        let mut h = harness();
        h.engine
            .observe(&status(with_agent(healthy(), "codex_cli", true, "broken")));
        assert!(h.notifier.sent().is_empty());
        h.clock
            .advance(AGENT_BROKEN_DEBOUNCE - Duration::from_secs(1));
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
        h.clock.advance(Duration::from_secs(1));
        h.engine.tick();
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::AgentBroken {
                agent_name: "Codex"
            }]
        );
        h.clock.advance(Duration::from_secs(600));
        h.engine.tick();
        h.engine
            .observe(&status(with_agent(healthy(), "codex_cli", true, "broken")));
        assert_eq!(h.notifier.sent().len(), 1);
    }

    fn with_problems(mut status: CompanionStatus, problems: &[&str]) -> CompanionStatus {
        if let Some(agent) = status.agents.last_mut() {
            agent.integration.problems = problems.iter().map(|problem| (*problem).into()).collect();
        }
        status
    }

    fn not_connected(mut status: CompanionStatus) -> CompanionStatus {
        status.connected = false;
        status.capture.state = "not_connected".into();
        status
    }

    #[test]
    fn agent_notices_wait_until_the_device_is_connected() {
        let mut h = harness();
        let before_pairing = not_connected(with_agent(healthy(), "claude_code", true, "broken"));
        h.engine.observe(&status(before_pairing));
        h.engine
            .observe(&attention(vec![("agent_broken", Some("claude_code"))]));
        h.engine.observe(&status(not_connected(with_agent(
            healthy(),
            "codex_cli",
            false,
            "needs_trust",
        ))));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE * 3);
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn the_debounce_starts_when_the_device_connects() {
        let mut h = harness();
        h.engine.observe(&status(not_connected(with_agent(
            healthy(),
            "claude_code",
            true,
            "broken",
        ))));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE * 3);
        h.engine.observe(&status(with_agent(
            healthy(),
            "claude_code",
            true,
            "broken",
        )));
        h.clock
            .advance(AGENT_BROKEN_DEBOUNCE - Duration::from_secs(1));
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
        h.clock.advance(Duration::from_secs(1));
        h.engine.tick();
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::AgentBroken {
                agent_name: "Claude Code"
            }]
        );
    }

    #[test]
    fn device_notices_are_not_held_while_disconnected() {
        let mut h = harness();
        h.engine.observe(&status(revoked()));
        assert_eq!(h.notifier.sent(), vec![Notice::DeviceRevoked]);
    }

    #[test]
    fn agent_notices_wait_for_onboarding_to_finish() {
        let mut h = harness();
        h.engine.set_onboarding_active(true);
        h.engine.observe(&status(with_agent(
            healthy(),
            "claude_code",
            true,
            "broken",
        )));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE * 3);
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
        h.engine.set_onboarding_active(false);
        h.engine.tick();
        assert!(
            h.notifier.sent().is_empty(),
            "the debounce starts after onboarding"
        );
        h.clock.advance(AGENT_BROKEN_DEBOUNCE);
        h.engine.tick();
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::AgentBroken {
                agent_name: "Claude Code"
            }]
        );
    }

    #[test]
    fn a_hook_that_only_points_at_another_copy_never_says_capture_stopped() {
        let mut h = harness();
        h.engine.observe(&status(with_problems(
            with_agent(healthy(), "claude_code", true, "broken"),
            &["Stop:stale", "SessionStart:stale"],
        )));
        h.engine
            .observe(&attention(vec![("agent_broken", Some("claude_code"))]));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE * 3);
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn a_missing_hook_alongside_a_stale_one_still_says_capture_stopped() {
        let mut h = harness();
        h.engine.observe(&status(with_problems(
            with_agent(healthy(), "claude_code", true, "broken"),
            &["Stop:stale", "PreToolUse:missing"],
        )));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE);
        h.engine.tick();
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::AgentBroken {
                agent_name: "Claude Code"
            }]
        );
    }

    #[test]
    fn agent_broken_that_recovers_within_the_debounce_never_notifies() {
        let mut h = harness();
        h.engine.observe(&status(with_agent(
            healthy(),
            "claude_code",
            true,
            "broken",
        )));
        h.clock.advance(Duration::from_secs(240));
        h.engine.observe(&status(with_agent(
            healthy(),
            "claude_code",
            false,
            "uploading",
        )));
        h.clock.advance(Duration::from_secs(120));
        h.engine.observe(&status(with_agent(
            healthy(),
            "claude_code",
            true,
            "broken",
        )));
        h.clock.advance(Duration::from_secs(120));
        h.engine.tick();
        assert!(
            h.notifier.sent().is_empty(),
            "a flap restarts the five-minute window"
        );
        h.clock.advance(Duration::from_secs(180));
        h.engine.tick();
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::AgentBroken {
                agent_name: "Claude Code"
            }]
        );
    }

    #[test]
    fn agent_broken_is_tracked_per_agent() {
        let mut h = harness();
        let both = with_agent(
            with_agent(healthy(), "claude_code", true, "broken"),
            "pi_cli",
            true,
            "broken",
        );
        h.engine.observe(&status(both));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE);
        h.engine.tick();
        let mut sent = h.notifier.sent();
        sent.sort_by_key(|notice| format!("{notice:?}"));
        assert_eq!(
            sent,
            vec![
                Notice::AgentBroken {
                    agent_name: "Claude Code"
                },
                Notice::AgentBroken { agent_name: "Pi" },
            ]
        );
    }

    #[test]
    fn needs_trust_notifies_once_per_agent_until_trusted() {
        let mut h = harness();
        h.engine.observe(&status(with_agent(
            healthy(),
            "codex_cli",
            false,
            "needs_trust",
        )));
        h.engine
            .observe(&attention(vec![("needs_trust", Some("codex_cli"))]));
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::NeedsTrust {
                agent_name: "Codex"
            }]
        );
        h.engine.observe(&status(with_agent(
            healthy(),
            "codex_cli",
            false,
            "uploading",
        )));
        h.engine.observe(&attention(vec![]));
        h.engine
            .observe(&attention(vec![("needs_trust", Some("codex_cli"))]));
        assert_eq!(h.notifier.sent().len(), 2);
    }

    #[test]
    fn a_condition_still_reported_by_one_source_stays_unresolved() {
        let mut h = harness();
        h.engine
            .observe(&attention(vec![("needs_trust", Some("codex_cli"))]));
        h.engine.observe(&status(with_agent(
            healthy(),
            "codex_cli",
            false,
            "needs_trust",
        )));
        h.engine.observe(&attention(vec![]));
        h.engine
            .observe(&attention(vec![("needs_trust", Some("codex_cli"))]));
        assert_eq!(h.notifier.sent().len(), 1);
    }

    #[test]
    fn a_daemon_outage_does_not_resolve_conditions() {
        let mut h = harness();
        h.engine.observe(&status(revoked()));
        h.engine.observe(&DaemonStreamMessage::Unreachable {
            reason: "socket_unavailable".into(),
        });
        h.engine.observe(&DaemonStreamMessage::Connected);
        h.engine.observe(&status(revoked()));
        assert_eq!(h.notifier.sent(), vec![Notice::DeviceRevoked]);
    }

    #[test]
    fn nothing_is_sent_while_notifications_are_off() {
        let mut h = harness();
        h.enabled.store(false, Ordering::SeqCst);
        h.engine.observe(&status(revoked()));
        h.engine.observe(&status(with_agent(
            paused_by_server(),
            "pi_cli",
            true,
            "broken",
        )));
        h.clock.advance(AGENT_BROKEN_DEBOUNCE);
        h.engine.tick();
        h.engine.capture_repaired();
        h.engine.update_rolled_back();
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn a_condition_raised_while_off_does_not_fire_when_turned_back_on() {
        let mut h = harness();
        h.enabled.store(false, Ordering::SeqCst);
        h.engine.observe(&status(paused_by_server()));
        h.enabled.store(true, Ordering::SeqCst);
        h.engine.observe(&status(paused_by_server()));
        h.engine.tick();
        assert!(h.notifier.sent().is_empty());
        h.engine.observe(&status(healthy()));
        h.engine.observe(&status(paused_by_server()));
        assert_eq!(h.notifier.sent(), vec![Notice::PausedByServer]);
    }

    #[test]
    fn capture_repaired_and_update_rolled_back_notify_each_time() {
        let mut h = harness();
        h.engine.capture_repaired();
        h.engine.update_rolled_back();
        assert_eq!(
            h.notifier.sent(),
            vec![Notice::CaptureRepaired, Notice::UpdateRolledBack]
        );
    }

    fn rolled_back(restored: bool) -> LaunchOutcome {
        LaunchOutcome::RolledBack {
            failure: crate::update::UpdateFailed {
                from_version: "0.1.0".into(),
                to_version: "0.2.0".into(),
                reason: crate::update::UpdateFailureReason::Unhealthy,
                detail: "/home/someone/Applications/x.app".into(),
                failed_at_unix: 0,
            },
            restored,
        }
    }

    #[test]
    fn a_rolled_back_launch_notifies_that_the_update_failed() {
        for restored in [true, false] {
            let mut h = harness();
            observe_launch_outcome(&mut h.engine, &rolled_back(restored));
            assert_eq!(h.notifier.sent(), vec![Notice::UpdateRolledBack]);
        }
    }

    #[test]
    fn a_successful_update_launch_notifies_nothing() {
        let mut h = harness();
        observe_launch_outcome(
            &mut h.engine,
            &LaunchOutcome::Updated {
                version: "0.2.0".into(),
            },
        );
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn a_rolled_back_launch_stays_quiet_while_notifications_are_off() {
        let mut h = harness();
        h.enabled.store(false, Ordering::SeqCst);
        observe_launch_outcome(&mut h.engine, &rolled_back(true));
        assert!(h.notifier.sent().is_empty());
    }

    #[test]
    fn agent_display_name_maps_daemon_ids_and_hides_unknown_ones() {
        assert_eq!(agent_display_name("claude_code"), "Claude Code");
        assert_eq!(agent_display_name("codex_cli"), "Codex");
        assert_eq!(agent_display_name("pi_cli"), "Pi");
        assert_eq!(agent_display_name("/home/x/evil"), "An agent");
    }

    #[test]
    fn templates_carry_no_paths_or_daemon_text() {
        let notices = [
            Notice::DeviceRevoked,
            Notice::AgentBroken {
                agent_name: "Claude Code",
            },
            Notice::NeedsTrust {
                agent_name: "Codex",
            },
            Notice::PausedByServer,
            Notice::CaptureRepaired,
            Notice::UpdateRolledBack,
        ];
        let mut titles = HashSet::new();
        for notice in notices {
            let (title, body) = (notice.title(), notice.body());
            assert!(!title.is_empty() && !body.is_empty(), "{notice:?}");
            for text in [&title, &body] {
                assert!(!text.contains('/') && !text.contains('~'), "{text}");
            }
            titles.insert(title);
        }
        assert_eq!(titles.len(), 6, "every condition has its own title");
        assert!(Notice::AgentBroken {
            agent_name: "Claude Code"
        }
        .title()
        .contains("Claude Code"));
        assert!(Notice::NeedsTrust {
            agent_name: "Codex"
        }
        .body()
        .contains("Codex"));
    }
}
