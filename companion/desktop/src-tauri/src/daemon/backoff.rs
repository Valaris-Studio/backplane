// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use std::time::Duration;

/// Exponential reconnect delay. No jitter: there is exactly one client per
/// local socket, so there is no herd to spread.
#[derive(Debug, Clone)]
pub struct Backoff {
    initial: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(initial: Duration, max: Duration) -> Self {
        Self {
            initial,
            max,
            attempt: 0,
        }
    }

    pub fn next_delay(&mut self) -> Duration {
        let factor = 1u32.checked_shl(self.attempt).unwrap_or(u32::MAX);
        self.attempt = self.attempt.saturating_add(1);
        self.initial.saturating_mul(factor).min(self.max)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backoff() -> Backoff {
        Backoff::new(Duration::from_millis(250), Duration::from_secs(10))
    }

    #[test]
    fn next_delay_doubles_from_the_initial_delay() {
        let mut backoff = backoff();
        let delays: Vec<u128> = (0..4).map(|_| backoff.next_delay().as_millis()).collect();
        assert_eq!(delays, vec![250, 500, 1000, 2000]);
    }

    #[test]
    fn next_delay_caps_at_the_maximum() {
        let mut backoff = backoff();
        let last = (0..10).map(|_| backoff.next_delay()).last().unwrap();
        assert_eq!(last, Duration::from_secs(10));
    }

    #[test]
    fn next_delay_never_overflows_after_many_attempts() {
        let mut backoff = backoff();
        for _ in 0..500 {
            assert!(backoff.next_delay() <= Duration::from_secs(10));
        }
    }

    #[test]
    fn reset_restarts_from_the_initial_delay() {
        let mut backoff = backoff();
        backoff.next_delay();
        backoff.next_delay();
        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_millis(250));
    }
}
