// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Launch at login through tauri-plugin-autostart. Behind a trait so tests
//! never touch ~/Library/LaunchAgents.

use crate::daemon::DaemonError;

pub trait LoginItem {
    fn is_enabled(&self) -> Result<bool, String>;
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
}

fn login_item_error(error: String) -> DaemonError {
    DaemonError::local(format!("the login item could not be changed: {error}"))
}

pub fn launch_at_login(item: &dyn LoginItem) -> Result<bool, DaemonError> {
    item.is_enabled().map_err(login_item_error)
}

/// Reads the state back rather than echoing the request, so the switch shows
/// what macOS actually has.
pub fn set_launch_at_login(item: &dyn LoginItem, enabled: bool) -> Result<bool, DaemonError> {
    if enabled {
        item.enable()
    } else {
        item.disable()
    }
    .map_err(login_item_error)?;
    launch_at_login(item)
}

/// For Remove Companion: off and confirmed off, or why not. Disables even
/// when the state can't be read, since a leftover entry relaunches the app
/// into onboarding at the next login.
pub fn turn_off_launch_at_login(item: &dyn LoginItem) -> Result<(), String> {
    if item.is_enabled() == Ok(false) {
        return Ok(());
    }
    item.disable()?;
    match item.is_enabled()? {
        false => Ok(()),
        true => Err("launch at login is still registered".into()),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    #[derive(Default)]
    struct FakeLoginItem {
        enabled: Cell<bool>,
        fail_writes: bool,
        fail_reads: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl LoginItem for FakeLoginItem {
        fn is_enabled(&self) -> Result<bool, String> {
            self.calls.borrow_mut().push("is_enabled");
            if self.fail_reads {
                return Err("launchctl unavailable".into());
            }
            Ok(self.enabled.get())
        }
        fn enable(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("enable");
            if self.fail_writes {
                return Err("permission denied".into());
            }
            self.enabled.set(true);
            Ok(())
        }
        fn disable(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("disable");
            if self.fail_writes {
                return Err("permission denied".into());
            }
            self.enabled.set(false);
            Ok(())
        }
    }

    #[test]
    fn launch_at_login_reports_the_registered_state() {
        let item = FakeLoginItem::default();
        assert_eq!(launch_at_login(&item), Ok(false));
        item.enabled.set(true);
        assert_eq!(launch_at_login(&item), Ok(true));
    }

    #[test]
    fn set_launch_at_login_enables_and_disables_then_reads_back() {
        let item = FakeLoginItem::default();
        assert_eq!(set_launch_at_login(&item, true), Ok(true));
        assert_eq!(set_launch_at_login(&item, false), Ok(false));
        assert_eq!(
            *item.calls.borrow(),
            vec!["enable", "is_enabled", "disable", "is_enabled"]
        );
    }

    #[test]
    fn launch_at_login_failures_are_local_errors() {
        let broken_reads = FakeLoginItem {
            fail_reads: true,
            ..FakeLoginItem::default()
        };
        assert!(matches!(
            launch_at_login(&broken_reads),
            Err(DaemonError::Local { .. })
        ));
        let broken_writes = FakeLoginItem {
            fail_writes: true,
            ..FakeLoginItem::default()
        };
        assert!(matches!(
            set_launch_at_login(&broken_writes, true),
            Err(DaemonError::Local { .. })
        ));
        assert!(!broken_writes.enabled.get());
    }

    #[test]
    fn turn_off_launch_at_login_when_already_off_is_a_no_op() {
        let item = FakeLoginItem::default();
        assert_eq!(turn_off_launch_at_login(&item), Ok(()));
        assert_eq!(*item.calls.borrow(), vec!["is_enabled"]);
    }

    #[test]
    fn turn_off_launch_at_login_disables_then_confirms() {
        let item = FakeLoginItem::default();
        item.enabled.set(true);
        assert_eq!(turn_off_launch_at_login(&item), Ok(()));
        assert!(!item.enabled.get());
        assert_eq!(
            *item.calls.borrow(),
            vec!["is_enabled", "disable", "is_enabled"]
        );
    }

    #[test]
    fn turn_off_launch_at_login_reports_a_failed_disable() {
        let item = FakeLoginItem {
            fail_writes: true,
            ..FakeLoginItem::default()
        };
        item.enabled.set(true);
        assert!(turn_off_launch_at_login(&item)
            .unwrap_err()
            .contains("permission denied"));
        assert!(item.enabled.get());
    }

    #[test]
    fn turn_off_launch_at_login_still_disables_when_the_state_is_unreadable() {
        let item = FakeLoginItem {
            fail_reads: true,
            ..FakeLoginItem::default()
        };
        item.enabled.set(true);
        assert!(turn_off_launch_at_login(&item).is_err());
        assert!(item.calls.borrow().contains(&"disable"));
        assert!(!item.enabled.get());
    }
}
