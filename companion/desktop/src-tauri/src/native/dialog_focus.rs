// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! While a native dialog is up, the popover panel loses key status to it; its
//! hide-on-resign-key must not fire then, or the dialog's owner vanishes
//! behind it. A guard per open dialog keeps that exception scoped: dropping
//! it (on choice, cancel, error, or a callback that never runs) restores it.

use std::sync::atomic::{AtomicUsize, Ordering};

pub struct BlurSuppression {
    open_dialogs: AtomicUsize,
}

pub struct SuppressionGuard<'a> {
    owner: &'a BlurSuppression,
}

impl BlurSuppression {
    pub const fn new() -> Self {
        Self {
            open_dialogs: AtomicUsize::new(0),
        }
    }

    pub fn suppress(&self) -> SuppressionGuard<'_> {
        self.open_dialogs.fetch_add(1, Ordering::SeqCst);
        SuppressionGuard { owner: self }
    }

    pub fn is_suppressed(&self) -> bool {
        self.open_dialogs.load(Ordering::SeqCst) > 0
    }
}

impl Default for BlurSuppression {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SuppressionGuard<'_> {
    fn drop(&mut self) {
        self.owner.open_dialogs.fetch_sub(1, Ordering::SeqCst);
    }
}

pub static POPOVER_BLUR: BlurSuppression = BlurSuppression::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppression_is_off_until_a_dialog_opens_and_back_off_after() {
        let blur = BlurSuppression::new();
        assert!(!blur.is_suppressed());
        {
            let _dialog = blur.suppress();
            assert!(blur.is_suppressed());
        }
        assert!(!blur.is_suppressed());
    }

    #[test]
    fn overlapping_dialogs_keep_it_suppressed_until_the_last_closes() {
        let blur = BlurSuppression::new();
        let first = blur.suppress();
        let second = blur.suppress();
        drop(first);
        assert!(blur.is_suppressed());
        drop(second);
        assert!(!blur.is_suppressed());
    }

    #[test]
    fn an_early_error_return_restores_it() {
        let blur = BlurSuppression::new();
        let failing = || -> Result<(), &'static str> {
            let _dialog = blur.suppress();
            Err("dialog failed")?;
            Ok(())
        };
        assert!(failing().is_err());
        assert!(!blur.is_suppressed());
    }

    #[test]
    fn a_panic_while_open_restores_it() {
        let blur = BlurSuppression::new();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _dialog = blur.suppress();
            panic!("callback panicked");
        }));
        assert!(outcome.is_err());
        assert!(!blur.is_suppressed());
    }

    #[test]
    fn a_callback_dropped_without_running_restores_it() {
        let dialog = POPOVER_BLUR.suppress();
        let callback = move |_choice: Option<()>| drop(dialog);
        assert!(POPOVER_BLUR.is_suppressed());
        drop(callback);
        assert!(!POPOVER_BLUR.is_suppressed());
    }

    #[test]
    fn a_callback_that_runs_restores_it() {
        let blur: &'static BlurSuppression = Box::leak(Box::new(BlurSuppression::new()));
        let dialog = blur.suppress();
        let callback = move |_choice: Option<()>| drop(dialog);
        callback(None);
        assert!(!blur.is_suppressed());
    }
}
