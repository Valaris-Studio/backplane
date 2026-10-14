// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Fans the single daemon event stream out to webviews and the tray, and
//! replays the current state to a late subscriber (a reloaded webview).

use std::collections::HashMap;
use std::sync::Mutex;

use super::types::{CompanionStatus, DaemonStreamMessage};

/// Returns false once its receiver is gone, which unsubscribes it.
pub type Subscriber = Box<dyn Fn(&DaemonStreamMessage) -> bool + Send + Sync>;

#[derive(Default)]
pub struct EventHub {
    state: Mutex<HubState>,
}

#[derive(Default)]
struct HubState {
    connection: Option<DaemonStreamMessage>,
    status: Option<CompanionStatus>,
    attention_items: usize,
    subscribers: HashMap<String, Subscriber>,
}

impl EventHub {
    /// Keyed by webview label: a reloaded page replaces its old channel
    /// instead of leaking one that can never report itself closed.
    pub fn subscribe(&self, key: impl Into<String>, subscriber: Subscriber) {
        let mut state = self.lock();
        let mut replay = Vec::new();
        if let Some(connection) = &state.connection {
            replay.push(connection.clone());
        }
        if state.connected() {
            if let Some(status) = &state.status {
                replay.push(DaemonStreamMessage::Status(Box::new(status.clone())));
            }
        }
        if replay.iter().all(&subscriber) {
            state.subscribers.insert(key.into(), subscriber);
        }
    }

    pub fn publish(&self, message: DaemonStreamMessage) {
        let mut state = self.lock();
        match &message {
            DaemonStreamMessage::Connected => state.connection = Some(message.clone()),
            DaemonStreamMessage::Unreachable { .. } => {
                state.connection = Some(message.clone());
                state.attention_items = 0;
            }
            DaemonStreamMessage::Attention(attention) => {
                state.attention_items = attention.items.len()
            }
            DaemonStreamMessage::Status(status) => state.status = Some(status.as_ref().clone()),
            _ => {}
        }
        state
            .subscribers
            .retain(|_, subscriber| subscriber(&message));
    }

    pub fn latest_status(&self) -> Option<CompanionStatus> {
        self.lock().status.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.lock().connected()
    }

    pub fn attention_count(&self) -> usize {
        self.lock().attention_items
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HubState> {
        // A panicking subscriber must not take the tray and every webview down with it.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl HubState {
    fn connected(&self) -> bool {
        matches!(self.connection, Some(DaemonStreamMessage::Connected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::types::{AttentionEvent, AttentionItem};
    use std::sync::Arc;

    fn recorder() -> (Arc<Mutex<Vec<DaemonStreamMessage>>>, Subscriber) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (
            seen,
            Box::new(move |message: &DaemonStreamMessage| {
                sink.lock().unwrap().push(message.clone());
                true
            }),
        )
    }

    fn status(state: &str) -> DaemonStreamMessage {
        let mut status = CompanionStatus::default();
        status.capture.state = state.into();
        DaemonStreamMessage::Status(Box::new(status))
    }

    #[test]
    fn publish_fans_out_to_every_subscriber() {
        let hub = EventHub::default();
        let (first, first_sub) = recorder();
        let (second, second_sub) = recorder();
        hub.subscribe("popover", first_sub);
        hub.subscribe("settings", second_sub);
        hub.publish(DaemonStreamMessage::PolicyChanged);
        assert_eq!(
            *first.lock().unwrap(),
            vec![DaemonStreamMessage::PolicyChanged]
        );
        assert_eq!(
            *second.lock().unwrap(),
            vec![DaemonStreamMessage::PolicyChanged]
        );
    }

    #[test]
    fn subscribe_replays_connection_then_status_when_connected() {
        let hub = EventHub::default();
        hub.publish(DaemonStreamMessage::Connected);
        hub.publish(status("active"));
        let (seen, sub) = recorder();
        hub.subscribe("popover", sub);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![DaemonStreamMessage::Connected, status("active")]
        );
    }

    #[test]
    fn subscribe_does_not_replay_stale_status_while_unreachable() {
        let hub = EventHub::default();
        hub.publish(DaemonStreamMessage::Connected);
        hub.publish(status("active"));
        hub.publish(DaemonStreamMessage::Unreachable {
            reason: "socket_unavailable".into(),
        });
        let (seen, sub) = recorder();
        hub.subscribe("popover", sub);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![DaemonStreamMessage::Unreachable {
                reason: "socket_unavailable".into()
            }]
        );
        assert!(!hub.is_connected());
    }

    #[test]
    fn subscribe_with_the_same_key_replaces_the_previous_subscriber() {
        let hub = EventHub::default();
        let (old, old_sub) = recorder();
        let (new, new_sub) = recorder();
        hub.subscribe("popover", old_sub);
        hub.subscribe("popover", new_sub);
        hub.publish(DaemonStreamMessage::PolicyChanged);
        assert!(old.lock().unwrap().is_empty());
        assert_eq!(new.lock().unwrap().len(), 1);
    }

    #[test]
    fn publish_drops_a_subscriber_whose_receiver_is_gone() {
        let hub = EventHub::default();
        let calls = Arc::new(Mutex::new(0));
        let counter = calls.clone();
        hub.subscribe(
            "popover",
            Box::new(move |_| {
                *counter.lock().unwrap() += 1;
                false
            }),
        );
        hub.publish(DaemonStreamMessage::PolicyChanged);
        hub.publish(DaemonStreamMessage::PolicyChanged);
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    fn attention(count: usize) -> DaemonStreamMessage {
        let item = AttentionItem {
            code: "hook_errors".into(),
            severity: "warning".into(),
            agent: None,
            message: "m".into(),
        };
        DaemonStreamMessage::Attention(AttentionEvent {
            items: vec![item; count],
        })
    }

    #[test]
    fn attention_count_follows_the_latest_attention_event() {
        let hub = EventHub::default();
        assert_eq!(hub.attention_count(), 0);
        hub.publish(attention(2));
        assert_eq!(hub.attention_count(), 2);
        hub.publish(attention(0));
        assert_eq!(hub.attention_count(), 0);
    }

    #[test]
    fn attention_count_resets_when_the_daemon_becomes_unreachable() {
        let hub = EventHub::default();
        hub.publish(attention(1));
        hub.publish(DaemonStreamMessage::Unreachable {
            reason: "socket_unavailable".into(),
        });
        assert_eq!(hub.attention_count(), 0);
    }

    #[test]
    fn latest_status_tracks_the_most_recent_status_event() {
        let hub = EventHub::default();
        assert_eq!(hub.latest_status(), None);
        hub.publish(DaemonStreamMessage::Connected);
        hub.publish(status("active"));
        hub.publish(status("paused_locally"));
        assert_eq!(hub.latest_status().unwrap().capture.state, "paused_locally");
        assert!(hub.is_connected());
    }
}
