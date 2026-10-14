// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Whether this desktop can show a tray icon at all, and what startup and the
//! tray menu look like because of it. Plain GNOME (Debian, Fedora Workstation)
//! has no StatusNotifier host, so there the window is the whole app.

use super::PlatformOs;

/// The D-Bus name a StatusNotifier host (KDE, GNOME's AppIndicator extension,
/// XFCE, …) owns; ksni registers the tray icon with it.
pub const STATUS_NOTIFIER_WATCHER: &str = "org.kde.StatusNotifierWatcher";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayHost {
    Present,
    Absent,
    /// The session bus could not be asked; treated as no host.
    Unknown,
}

impl TrayHost {
    pub fn from_probe<E>(name_has_owner: Result<bool, E>) -> Self {
        match name_has_owner {
            Ok(true) => Self::Present,
            Ok(false) => Self::Absent,
            Err(_) => Self::Unknown,
        }
    }
}

/// At login the panel may register its StatusNotifier host after this app
/// starts, so a login launch keeps asking for a while before it gives up on
/// the tray.
pub const LOGIN_PROBE_ATTEMPTS: usize = 10;
pub const LOGIN_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

pub fn wait_for_tray_host(
    attempts: usize,
    mut probe: impl FnMut() -> TrayHost,
    mut sleep: impl FnMut(std::time::Duration),
) -> TrayHost {
    let mut host = probe();
    for _ in 1..attempts {
        if host == TrayHost::Present {
            break;
        }
        sleep(LOGIN_PROBE_INTERVAL);
        host = probe();
    }
    host
}

#[cfg(target_os = "linux")]
pub fn probe_session_bus() -> TrayHost {
    probe_bus_at(None)
}

/// `address` None is the session bus from the environment.
#[cfg(target_os = "linux")]
pub fn probe_bus_at(address: Option<&str>) -> TrayHost {
    TrayHost::from_probe(bus_name_has_owner(address, STATUS_NOTIFIER_WATCHER))
}

#[cfg(target_os = "linux")]
fn bus_name_has_owner(address: Option<&str>, name: &str) -> zbus::Result<bool> {
    let connection = match address {
        Some(address) => zbus::blocking::connection::Builder::address(address)?.build()?,
        None => zbus::blocking::Connection::session()?,
    };
    let bus = zbus::blocking::fdo::DBusProxy::new(&connection)?;
    Ok(bus.name_has_owner(zbus::names::BusName::try_from(name)?)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupPlan {
    pub show_window: bool,
    /// Tell the user (once) why there is no tray icon and how to get one.
    pub explain_missing_tray: bool,
    /// With no tray icon, closing the window is the only way to quit.
    pub close_quits: bool,
}

pub fn startup_plan(
    os: PlatformOs,
    host: TrayHost,
    launched_at_login: bool,
    already_explained: bool,
) -> StartupPlan {
    let menu_window = matches!(os, PlatformOs::Linux | PlatformOs::Unknown);
    let no_tray = menu_window && host != TrayHost::Present;
    StartupPlan {
        // A login launch stays in the tray; one from the app menu wants the window.
        show_window: menu_window && (no_tray || !launched_at_login),
        explain_missing_tray: no_tray && !already_explained,
        close_quits: no_tray,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayMenuEntry {
    Status,
    Separator,
    PauseResume,
    /// Opens Backplane on the web (macOS and Windows).
    OpenBackplane,
    /// Shows the app window (Linux, where clicks on the icon are unreliable).
    OpenCompanion,
    Quit,
}

pub const OPEN_COMPANION_LABEL: &str = "Open Backplane Companion…";

pub fn tray_menu_entries(os: PlatformOs) -> &'static [TrayMenuEntry] {
    use TrayMenuEntry::*;
    match os {
        PlatformOs::Macos | PlatformOs::Windows => &[
            Status,
            Separator,
            PauseResume,
            OpenBackplane,
            Separator,
            Quit,
        ],
        PlatformOs::Linux | PlatformOs::Unknown => &[
            Status,
            Separator,
            PauseResume,
            OpenCompanion,
            Separator,
            Quit,
        ],
    }
}

/// Whether an entry can be chosen; Status is a label, never an action.
pub fn tray_entry_enabled(
    entry: TrayMenuEntry,
    daemon_connected: bool,
    can_pause_or_resume: bool,
    backplane_target_known: bool,
) -> bool {
    match entry {
        TrayMenuEntry::Status | TrayMenuEntry::Separator => false,
        TrayMenuEntry::PauseResume => can_pause_or_resume,
        TrayMenuEntry::OpenBackplane => daemon_connected && backplane_target_known,
        TrayMenuEntry::OpenCompanion | TrayMenuEntry::Quit => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use TrayMenuEntry::*;

    #[test]
    fn tray_host_present_keeps_tray_only_startup() {
        let plan = startup_plan(PlatformOs::Linux, TrayHost::Present, true, false);
        assert_eq!(
            plan,
            StartupPlan {
                show_window: false,
                explain_missing_tray: false,
                close_quits: false,
            }
        );
    }

    #[test]
    fn tray_host_present_and_launched_by_hand_shows_the_window() {
        let plan = startup_plan(PlatformOs::Linux, TrayHost::Present, false, false);
        assert!(plan.show_window);
        assert!(!plan.explain_missing_tray);
        assert!(!plan.close_quits);
    }

    #[test]
    fn no_tray_host_shows_window_at_login_with_explanation() {
        for host in [TrayHost::Absent, TrayHost::Unknown] {
            for launched_at_login in [true, false] {
                let plan = startup_plan(PlatformOs::Linux, host, launched_at_login, false);
                assert_eq!(
                    plan,
                    StartupPlan {
                        show_window: true,
                        explain_missing_tray: true,
                        close_quits: true,
                    },
                    "{host:?} {launched_at_login}"
                );
            }
        }
    }

    #[test]
    fn no_tray_host_explains_only_once() {
        let plan = startup_plan(PlatformOs::Linux, TrayHost::Absent, true, true);
        assert!(plan.show_window);
        assert!(!plan.explain_missing_tray);
    }

    #[test]
    fn macos_and_windows_startup_is_unchanged_tray_only() {
        for os in [PlatformOs::Macos, PlatformOs::Windows] {
            for host in [TrayHost::Present, TrayHost::Absent, TrayHost::Unknown] {
                assert_eq!(
                    startup_plan(os, host, false, false),
                    StartupPlan {
                        show_window: false,
                        explain_missing_tray: false,
                        close_quits: false,
                    },
                    "{os:?} {host:?}"
                );
            }
        }
    }

    #[test]
    fn tray_host_probe_errors_count_as_unknown() {
        assert_eq!(TrayHost::from_probe::<()>(Ok(true)), TrayHost::Present);
        assert_eq!(TrayHost::from_probe::<()>(Ok(false)), TrayHost::Absent);
        assert_eq!(
            TrayHost::from_probe(Err("no session bus")),
            TrayHost::Unknown
        );
    }

    #[test]
    fn wait_for_tray_host_stops_at_the_first_present_answer() {
        let mut answers = [TrayHost::Absent, TrayHost::Unknown, TrayHost::Present].into_iter();
        let mut sleeps = 0;
        let host = wait_for_tray_host(10, || answers.next().unwrap(), |_| sleeps += 1);
        assert_eq!(host, TrayHost::Present);
        assert_eq!(sleeps, 2);
    }

    #[test]
    fn wait_for_tray_host_gives_up_after_its_attempts() {
        let mut probes = 0;
        let mut sleeps = 0;
        let host = wait_for_tray_host(
            3,
            || {
                probes += 1;
                TrayHost::Absent
            },
            |_| sleeps += 1,
        );
        assert_eq!(host, TrayHost::Absent);
        assert_eq!((probes, sleeps), (3, 2));
    }

    #[test]
    fn wait_for_tray_host_asks_at_least_once() {
        let mut probes = 0;
        let host = wait_for_tray_host(
            0,
            || {
                probes += 1;
                TrayHost::Unknown
            },
            |_| panic!("no sleep for a single probe"),
        );
        assert_eq!(host, TrayHost::Unknown);
        assert_eq!(probes, 1);
    }

    /// Run in the Linux builder: `dbus-run-session -- cargo test -- --ignored session_bus`.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a private D-Bus session bus"]
    fn probe_session_bus_sees_a_watcher_come_and_go() {
        assert_eq!(probe_session_bus(), TrayHost::Absent);
        let watcher = zbus::blocking::connection::Builder::session()
            .unwrap()
            .name(STATUS_NOTIFIER_WATCHER)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(probe_session_bus(), TrayHost::Present);
        drop(watcher);
        assert_eq!(
            wait_for_tray_host(3, probe_session_bus, std::thread::sleep),
            TrayHost::Absent
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn probe_bus_at_an_unreachable_address_is_unknown() {
        assert_eq!(
            probe_bus_at(Some("unix:path=/nonexistent/bus")),
            TrayHost::Unknown
        );
    }

    #[test]
    fn linux_menu_is_status_pause_open_companion_and_quit() {
        assert_eq!(
            tray_menu_entries(PlatformOs::Linux),
            [
                Status,
                Separator,
                PauseResume,
                OpenCompanion,
                Separator,
                Quit
            ]
        );
    }

    #[test]
    fn macos_and_windows_menus_keep_open_backplane() {
        for os in [PlatformOs::Macos, PlatformOs::Windows] {
            assert_eq!(
                tray_menu_entries(os),
                [
                    Status,
                    Separator,
                    PauseResume,
                    OpenBackplane,
                    Separator,
                    Quit
                ],
                "{os:?}"
            );
        }
    }

    #[test]
    fn menu_open_item_disabled_never_hides_quit() {
        for os in [PlatformOs::Macos, PlatformOs::Windows, PlatformOs::Linux] {
            let entries = tray_menu_entries(os);
            assert_eq!(entries.last(), Some(&Quit), "{os:?}");
            assert!(!tray_entry_enabled(OpenBackplane, false, false, false));
            assert!(tray_entry_enabled(Quit, false, false, false));
        }
    }

    #[test]
    fn every_menu_layout_has_exactly_one_open_entry() {
        for os in [
            PlatformOs::Macos,
            PlatformOs::Windows,
            PlatformOs::Linux,
            PlatformOs::Unknown,
        ] {
            let open_entries = tray_menu_entries(os)
                .iter()
                .filter(|entry| matches!(entry, OpenBackplane | OpenCompanion))
                .count();
            assert_eq!(open_entries, 1, "{os:?}");
        }
    }

    #[test]
    fn open_companion_works_even_when_the_daemon_is_down() {
        assert!(tray_entry_enabled(OpenCompanion, false, false, false));
    }

    #[test]
    fn status_is_never_clickable_and_pause_follows_the_action() {
        assert!(!tray_entry_enabled(Status, true, true, true));
        assert!(!tray_entry_enabled(Separator, true, true, true));
        assert!(tray_entry_enabled(PauseResume, true, true, false));
        assert!(!tray_entry_enabled(PauseResume, true, false, true));
        assert!(tray_entry_enabled(OpenBackplane, true, false, true));
        assert!(!tray_entry_enabled(OpenBackplane, true, false, false));
    }

    #[test]
    fn unknown_os_uses_the_menu_first_layout() {
        assert_eq!(
            tray_menu_entries(PlatformOs::Unknown),
            tray_menu_entries(PlatformOs::Linux)
        );
    }
}
