// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Turning capture on from the app: the bundled companion registers its own
//! login service (a LaunchAgent on macOS) and repairs the agents' hooks, so both point at the binary
//! inside this app wherever it lives. Rust owns every argument and the whole
//! child environment; the webview only asks.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::daemon::types::AgentEntry;
use crate::native::agent_config::AgentId;
use crate::native::login_item::{self, LoginItem};
use crate::platform::install::{current_install_policy, require_file, InstallPolicy};
use crate::platform::PlatformOs;

pub const COMPANION_BINARY: &str = "backplane-companion";
/// launchd and systemd hand a GUI app a minimal PATH; the companion needs only system tools.
const UNIX_CHILD_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const WINDOWS_DEFAULT_SYSTEM_ROOT: &str = r"C:\Windows";
/// Variables the child keeps from the app's own environment. Anything else,
/// notably BACKPLANE_BEACON_ARTIFACT and BACKPLANE_OTELCOL_ARTIFACT, would be
/// baked into the login service by `service install`.
const UNIX_INHERITED_VARIABLES: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_MESSAGES",
];
/// `systemctl --user` and the Secret Service keyring are reached over the
/// session bus, and the companion's data directory follows XDG_STATE_HOME.
const LINUX_SESSION_VARIABLES: &[&str] = &[
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
];
/// The data directory lives under LOCALAPPDATA; SystemRoot locates schtasks.
const WINDOWS_INHERITED_VARIABLES: &[&str] = &[
    "USERPROFILE",
    "USERNAME",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
    "SystemDrive",
];
/// Passed on only when they hold an absolute path: a relative one would
/// resolve against whatever directory the service happens to start in.
const WINDOWS_PATH_VARIABLES: &[&str] = &[
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
    "SystemRoot",
];
/// Shared with the daemon discovery: the app and the service it installs must
/// use the same data directory.
const DATA_DIR_VARIABLE: &str = "BACKPLANE_COMPANION_HOME";
const MAX_MESSAGE_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureError {
    #[error("the companion is not bundled next to the app ({path})")]
    NotBundled { path: String },
    #[error("the app is running from a temporary location ({path}); install it first")]
    EphemeralLocation { path: String },
    /// Named for macOS's /Applications; on every platform it means "outside
    /// the install location the platform's policy trusts".
    #[error("the app is not in its trusted install location ({path}); install it there first")]
    NotInApplications { path: String },
    #[error("`backplane-companion {step}` failed: {message}")]
    CompanionFailed {
        step: String,
        exit_code: Option<i32>,
        message: String,
    },
    #[error("unexpected companion output from `{step}`: {message}")]
    Protocol { step: String, message: String },
    /// Every companion step finished (`report`); only launch at login is still on.
    #[error("launch at login could not be turned off: {message}")]
    LoginItemFailed {
        message: String,
        report: UninstallReport,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct AppLocation {
    /// Installed where the platform's install policy trusts it (on macOS, /Applications).
    pub in_applications: bool,
    /// The .app bundle, or the executable when not running from one.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ServiceState {
    pub definition: String,
    pub installed: bool,
    pub current: bool,
    pub enabled: bool,
    pub running: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct EnableCaptureReport {
    pub companion_path: String,
    pub service: ServiceState,
    pub daemon_running: bool,
    pub agents: Vec<AgentEntry>,
    /// A LaunchAgent from another install (e.g. the release archive) was
    /// replaced by one for this app.
    pub replaced_service: bool,
    /// Agents whose hooks pointed at another companion and now point here.
    pub repaired_agents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompanionOutput {
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl CompanionOutput {
    fn succeeded(&self) -> bool {
        self.exit_code == Some(0)
    }
}

pub trait CompanionRunner {
    fn run(
        &self,
        program: &Path,
        args: &[&str],
        environment: &[(String, OsString)],
    ) -> std::io::Result<CompanionOutput>;
}

/// Runs the companion with exactly the given environment.
pub struct ProcessRunner;

impl CompanionRunner for ProcessRunner {
    fn run(
        &self,
        program: &Path,
        args: &[&str],
        environment: &[(String, OsString)],
    ) -> std::io::Result<CompanionOutput> {
        let output = Command::new(program)
            .args(args)
            .env_clear()
            .envs(environment.iter().map(|(name, value)| (name, value)))
            .current_dir("/")
            .output()?;
        Ok(CompanionOutput {
            exit_code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

pub fn app_location(executable: &Path) -> AppLocation {
    current_install_policy().app_location(executable)
}

/// The companion beside the running app, refused unless the app is installed
/// where this platform's install policy trusts it.
pub fn bundled_companion(executable: &Path) -> Result<PathBuf, CaptureError> {
    current_install_policy().trusted_companion(executable)
}

pub fn companion_environment(getenv: impl Fn(&str) -> Option<OsString>) -> Vec<(String, OsString)> {
    companion_environment_for(PlatformOs::current(), getenv)
}

pub fn companion_environment_for(
    os: PlatformOs,
    getenv: impl Fn(&str) -> Option<OsString>,
) -> Vec<(String, OsString)> {
    let inherited: Vec<&str> = match os {
        PlatformOs::Windows => WINDOWS_INHERITED_VARIABLES.to_vec(),
        PlatformOs::Linux => [UNIX_INHERITED_VARIABLES, LINUX_SESSION_VARIABLES].concat(),
        PlatformOs::Macos | PlatformOs::Unknown => UNIX_INHERITED_VARIABLES.to_vec(),
    };
    let mut environment: Vec<(String, OsString)> = inherited
        .iter()
        .filter_map(|name| getenv(name).map(|value| (name.to_string(), value)))
        .filter(|(name, value)| {
            os != PlatformOs::Windows
                || !WINDOWS_PATH_VARIABLES.contains(&name.as_str())
                || is_absolute_on(os, value)
        })
        .collect();
    if let Some(data_dir) = getenv(DATA_DIR_VARIABLE).filter(|value| is_absolute_on(os, value)) {
        environment.push((DATA_DIR_VARIABLE.to_string(), data_dir));
    }
    let path = match os {
        PlatformOs::Windows => {
            let system_root = getenv("SystemRoot")
                .filter(|value| is_absolute_on(os, value))
                .unwrap_or_else(|| WINDOWS_DEFAULT_SYSTEM_ROOT.into());
            let system_root = system_root.to_string_lossy();
            format!("{system_root}\\System32;{system_root}").into()
        }
        PlatformOs::Macos | PlatformOs::Linux | PlatformOs::Unknown => UNIX_CHILD_PATH.into(),
    };
    environment.push(("PATH".to_string(), path));
    environment
}

/// Judged by the target platform's rules, not the host's, so `C:\x` is
/// absolute only on Windows and `/x` only elsewhere.
fn is_absolute_on(os: PlatformOs, value: &std::ffi::OsStr) -> bool {
    let value = value.to_string_lossy();
    match os {
        PlatformOs::Windows => {
            let bytes = value.as_bytes();
            bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/')
        }
        PlatformOs::Macos | PlatformOs::Linux | PlatformOs::Unknown => value.starts_with('/'),
    }
}

pub(crate) fn run_step<T: serde::de::DeserializeOwned>(
    runner: &dyn CompanionRunner,
    companion: &Path,
    environment: &[(String, OsString)],
    args: &[&str],
) -> Result<T, CaptureError> {
    let step = args.join(" ");
    let output = runner.run(companion, args, environment).map_err(|error| {
        CaptureError::CompanionFailed {
            step: step.clone(),
            exit_code: None,
            message: bounded(&error.to_string()),
        }
    })?;
    if !output.succeeded() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(CaptureError::CompanionFailed {
            step,
            exit_code: output.exit_code,
            message: bounded(
                message
                    .strip_prefix("backplane-companion: ")
                    .unwrap_or(message),
            ),
        });
    }
    serde_json::from_slice(&output.stdout).map_err(|error| CaptureError::Protocol {
        step,
        message: error.to_string(),
    })
}

fn bounded(message: &str) -> String {
    message.chars().take(MAX_MESSAGE_CHARS).collect()
}

#[derive(Deserialize)]
pub(crate) struct ServiceReport {
    pub(crate) service: ServiceState,
    pub(crate) daemon_running: bool,
}

fn points_at_another_companion(agent: &AgentEntry) -> bool {
    agent.integration.as_ref().is_some_and(|integration| {
        integration
            .problems
            .iter()
            .any(|problem| problem.ends_with(":stale") || problem == "companion_executable_missing")
    })
}

#[derive(Deserialize)]
struct CliStatus {
    capture: CliCapture,
}

#[derive(Deserialize)]
struct CliCapture {
    /// Required: a status without it must not read as "every agent".
    #[serde(deserialize_with = "present_nullable")]
    enabled_agents: Option<Vec<String>>,
}

fn present_nullable<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

/// The enabled agents present on this machine, as known daemon ids only, so
/// nothing from the policy ever becomes a free-form argument.
fn enabled_present_agents(enabled: &[String], presence: &[AgentEntry]) -> Vec<&'static str> {
    [AgentId::ClaudeCode, AgentId::CodexCli, AgentId::PiCli]
        .into_iter()
        .map(AgentId::as_str)
        .filter(|id| enabled.iter().any(|enabled_id| enabled_id == id))
        .filter(|id| {
            presence.iter().any(|entry| {
                entry.id == *id && entry.presence.as_ref().is_some_and(|found| found.installed)
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct ServiceStartReport {
    pub companion_path: String,
    pub service: ServiceState,
    pub daemon_running: bool,
    /// A LaunchAgent from another install was replaced by one for this app.
    pub replaced_service: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct AgentHooksReport {
    pub agents: Vec<AgentEntry>,
    /// Agents whose hooks pointed at another companion and now point here.
    pub repaired_agents: Vec<String>,
}

/// Installs and starts only the LaunchAgent, so the daemon serves the
/// control API (and pairing) before any connection or hook exists.
/// Idempotent: a current, running service is left alone.
pub fn start_companion_service(
    runner: &dyn CompanionRunner,
    companion: &Path,
    environment: &[(String, OsString)],
) -> Result<ServiceStartReport, CaptureError> {
    let before: ServiceReport = run_step(runner, companion, environment, &["service", "status"])?;
    let replaced_service = before.service.installed && !before.service.current;
    let after = if before.service.installed && before.service.current && before.service.running {
        before
    } else {
        run_step(runner, companion, environment, &["service", "install"])?
    };
    Ok(ServiceStartReport {
        companion_path: companion.to_string_lossy().into_owned(),
        service: after.service,
        daemon_running: after.daemon_running,
        replaced_service,
    })
}

/// Hooks only for the agents the policy enables (null enables every present
/// agent), so re-running it after a move never brings back hooks the user
/// turned off. `agents install` also rewrites hooks that point at another
/// companion (e.g. a release-archive install).
pub fn install_agent_hooks(
    runner: &dyn CompanionRunner,
    companion: &Path,
    environment: &[(String, OsString)],
) -> Result<AgentHooksReport, CaptureError> {
    let status: CliStatus = run_step(runner, companion, environment, &["status"])?;
    let agents_before: Vec<AgentEntry> =
        run_step(runner, companion, environment, &["agents", "status"])?;
    let (agents, installed_ids): (Vec<AgentEntry>, Option<Vec<&str>>) =
        match &status.capture.enabled_agents {
            None => (
                run_step(runner, companion, environment, &["agents", "install"])?,
                None,
            ),
            Some(enabled) => {
                let presence: Vec<AgentEntry> =
                    run_step(runner, companion, environment, &["agents", "list"])?;
                let targets = enabled_present_agents(enabled, &presence);
                if targets.is_empty() {
                    (agents_before.clone(), Some(targets))
                } else {
                    let args: Vec<&str> = ["agents", "install"]
                        .into_iter()
                        .chain(targets.iter().copied())
                        .collect();
                    (
                        run_step(runner, companion, environment, &args)?,
                        Some(targets),
                    )
                }
            }
        };
    Ok(AgentHooksReport {
        agents,
        repaired_agents: agents_before
            .iter()
            .filter(|agent| points_at_another_companion(agent))
            .filter(|agent| {
                installed_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&agent.id.as_str()))
            })
            .map(|agent| agent.id.clone())
            .collect(),
    })
}

/// Hooks first, then the service: the composition onboarding used before
/// the two steps were split (kept for compatibility).
pub fn enable_capture(
    runner: &dyn CompanionRunner,
    companion: &Path,
    environment: &[(String, OsString)],
) -> Result<EnableCaptureReport, CaptureError> {
    let hooks = install_agent_hooks(runner, companion, environment)?;
    let service = start_companion_service(runner, companion, environment)?;
    Ok(EnableCaptureReport {
        companion_path: service.companion_path,
        service: service.service,
        daemon_running: service.daemon_running,
        agents: hooks.agents,
        replaced_service: service.replaced_service,
        repaired_agents: hooks.repaired_agents,
    })
}

/// `uninstall --purge`: the companion removed itself and its data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UninstallReport {
    pub uninstalled: bool,
    /// The server revoked the device; best effort, false when unreachable.
    pub server_revoked: bool,
}

/// The companion beside the app, which must be installed where the platform's
/// policy trusts it, like every other command that runs it. Unlike
/// `bundled_companion`, a temporary location is reported as untrusted.
pub fn companion_for_removal(executable: &Path) -> Result<PathBuf, CaptureError> {
    companion_for_removal_with(&*current_install_policy(), executable)
}

pub(crate) fn companion_for_removal_with(
    policy: &dyn InstallPolicy,
    executable: &Path,
) -> Result<PathBuf, CaptureError> {
    require_file(policy.companion_beside_trusted_app(executable)?)
}

/// Remove Companion: the app's launch at login, then every agent's hooks,
/// then the LaunchAgent, then the device token and data (`uninstall --purge`
/// repeats the hooks and service, so a retry after a partial failure finishes
/// the job).
///
/// Launch at login goes first because it needs no daemon and must not outlive
/// a teardown that stops halfway: the next login would reopen the app into
/// onboarding. Its failure never stops the companion steps, and a failed
/// companion step is the one reported, as it left more behind.
/// The companion's error code (what its stderr starts with, in any locale)
/// for a daemon that did not exit in time.
const DAEMON_RUNNING_CODE: &str = "daemon_running:";

pub fn companion_uninstall(
    runner: &dyn CompanionRunner,
    companion: &Path,
    environment: &[(String, OsString)],
    login_item: &dyn LoginItem,
) -> Result<UninstallReport, CaptureError> {
    let login_item_off = login_item::turn_off_launch_at_login(login_item);
    let _: Vec<AgentEntry> = run_step(runner, companion, environment, &["agents", "uninstall"])?;
    match run_step::<ServiceReport>(runner, companion, environment, &["service", "uninstall"]) {
        // The service is gone but its daemon was still exiting; the purge
        // waits for it again and fails only if it never exits.
        Err(CaptureError::CompanionFailed { message, .. })
            if message.starts_with(DAEMON_RUNNING_CODE) => {}
        outcome => {
            outcome?;
        }
    }
    let report = run_step(runner, companion, environment, &["uninstall", "--purge"])?;
    match login_item_off {
        Ok(()) => Ok(report),
        Err(message) => Err(CaptureError::LoginItemFailed {
            message: bounded(&message),
            report,
        }),
    }
}

/// Emitted once at launch when the LaunchAgent pointed at another copy of the
/// companion (the app was moved) and was re-pointed at this one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct CaptureRepaired {
    pub companion_path: String,
    pub service: ServiceState,
    pub daemon_running: bool,
}

/// At launch: when capture is enabled (a LaunchAgent is installed) but starts
/// another executable, reinstall it for this app. Never enables capture that
/// was off, and never points it at a DMG or App Translocation copy.
pub fn repair_moved_service(
    runner: &dyn CompanionRunner,
    executable: &Path,
    environment: &[(String, OsString)],
) -> Result<Option<CaptureRepaired>, CaptureError> {
    repair_moved_service_with(runner, &*current_install_policy(), executable, environment)
}

pub(crate) fn repair_moved_service_with(
    runner: &dyn CompanionRunner,
    policy: &dyn InstallPolicy,
    executable: &Path,
    environment: &[(String, OsString)],
) -> Result<Option<CaptureRepaired>, CaptureError> {
    let companion = match policy.trusted_companion(executable) {
        Ok(companion) => companion,
        Err(
            CaptureError::EphemeralLocation { .. }
            | CaptureError::NotInApplications { .. }
            | CaptureError::NotBundled { .. },
        ) => return Ok(None),
        Err(error) => return Err(error),
    };
    let status: ServiceReport = run_step(runner, &companion, environment, &["service", "status"])?;
    if !status.service.installed || status.service.current {
        return Ok(None);
    }
    let repaired: ServiceReport =
        run_step(runner, &companion, environment, &["service", "install"])?;
    Ok(Some(CaptureRepaired {
        companion_path: companion.to_string_lossy().into_owned(),
        service: repaired.service,
        daemon_running: repaired.daemon_running,
    }))
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    use super::*;
    use crate::platform::install::{install_policy_for, InstallPolicy, MacosInstall};
    use crate::platform::PlatformOs;

    fn system_macos() -> Box<dyn InstallPolicy> {
        install_policy_for(PlatformOs::Macos, |_| None)
    }

    fn bundle_executable(root: &Path, app: &str) -> PathBuf {
        let macos = root.join(app).join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(macos.join("backplane-companion-desktop"), "").unwrap();
        macos.join("backplane-companion-desktop")
    }

    fn environment_on(os: PlatformOs, pairs: &[(&str, &str)]) -> Vec<(String, OsString)> {
        let variables: HashMap<String, OsString> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), OsString::from(value)))
            .collect();
        companion_environment_for(os, |key| variables.get(key).cloned())
    }

    fn environment_of(pairs: &[(&str, &str)]) -> Vec<(String, OsString)> {
        environment_on(PlatformOs::Macos, pairs)
    }

    fn names(environment: &[(String, OsString)]) -> Vec<&str> {
        environment.iter().map(|(key, _)| key.as_str()).collect()
    }

    fn value_of<'a>(environment: &'a [(String, OsString)], name: &str) -> Option<&'a OsString> {
        environment
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }

    #[test]
    fn companion_environment_keeps_identity_locale_and_data_dir() {
        let environment = environment_of(&[
            ("HOME", "/home/me"),
            ("USER", "me"),
            ("LANG", "de_DE.UTF-8"),
            ("BACKPLANE_COMPANION_HOME", "/home/me/bp"),
        ]);
        assert_eq!(
            names(&environment),
            ["HOME", "USER", "LANG", "BACKPLANE_COMPANION_HOME", "PATH"]
        );
        assert!(environment.contains(&("PATH".into(), UNIX_CHILD_PATH.into())));
    }

    #[test]
    fn companion_environment_drops_artifact_overrides_and_shell_state() {
        let environment = environment_of(&[
            ("HOME", "/home/me"),
            ("BACKPLANE_BEACON_ARTIFACT", "/tmp/dev/artifact.json"),
            ("BACKPLANE_OTELCOL_ARTIFACT", "/tmp/dev/otelcol.json"),
            ("BACKPLANE_API_KEY", "vlr_secret"),
            ("PATH", "/home/me/evil:/usr/bin"),
            ("DYLD_INSERT_LIBRARIES", "/tmp/x.dylib"),
        ]);
        for (name, value) in &environment {
            assert!(
                !name.starts_with("BACKPLANE_BEACON") && !name.starts_with("BACKPLANE_OTELCOL"),
                "{name}"
            );
            assert!(
                name != "BACKPLANE_API_KEY" && name != "DYLD_INSERT_LIBRARIES",
                "{name}"
            );
            if name == "PATH" {
                assert_eq!(value, UNIX_CHILD_PATH);
            }
        }
    }

    #[test]
    fn companion_environment_ignores_a_relative_data_dir() {
        let environment = environment_of(&[
            ("HOME", "/home/me"),
            ("BACKPLANE_COMPANION_HOME", "relative/dir"),
        ]);
        assert!(environment
            .iter()
            .all(|(name, _)| name != DATA_DIR_VARIABLE));
    }

    #[test]
    fn companion_environment_on_macos_never_passes_the_linux_session_variables() {
        let environment = environment_of(&[
            ("HOME", "/home/me"),
            ("XDG_STATE_HOME", "/home/me/.local/state"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/dbus"),
        ]);
        assert_eq!(names(&environment), ["HOME", "PATH"]);
    }

    #[test]
    fn companion_environment_on_linux_keeps_the_session_bus_and_xdg_dirs() {
        let environment = environment_on(
            PlatformOs::Linux,
            &[
                ("HOME", "/home/me"),
                ("USER", "me"),
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
                ("XDG_STATE_HOME", "/home/me/.local/state"),
                ("XDG_CONFIG_HOME", "/home/me/.config"),
                ("BACKPLANE_COMPANION_HOME", "/home/me/bp"),
            ],
        );
        assert_eq!(
            names(&environment),
            [
                "HOME",
                "USER",
                "XDG_RUNTIME_DIR",
                "DBUS_SESSION_BUS_ADDRESS",
                "XDG_STATE_HOME",
                "XDG_CONFIG_HOME",
                "BACKPLANE_COMPANION_HOME",
                "PATH"
            ]
        );
        assert_eq!(value_of(&environment, "PATH").unwrap(), UNIX_CHILD_PATH);
    }

    #[test]
    fn companion_environment_on_linux_drops_preload_and_shell_path() {
        let environment = environment_on(
            PlatformOs::Linux,
            &[
                ("HOME", "/home/me"),
                ("LD_PRELOAD", "/tmp/x.so"),
                ("LD_LIBRARY_PATH", "/tmp"),
                ("PATH", "/home/me/evil:/usr/bin"),
                ("APPIMAGE", "/home/me/Backplane.AppImage"),
                ("BACKPLANE_COMPANION_HOME", r"C:\bp"),
            ],
        );
        assert_eq!(names(&environment), ["HOME", "PATH"]);
        assert_eq!(value_of(&environment, "PATH").unwrap(), UNIX_CHILD_PATH);
    }

    #[test]
    fn companion_environment_on_windows_keeps_profile_dirs_and_a_system_path() {
        let environment = environment_on(
            PlatformOs::Windows,
            &[
                ("USERPROFILE", r"C:\home\me"),
                ("USERNAME", "me"),
                ("LOCALAPPDATA", r"C:\home\me\AppData\Local"),
                ("APPDATA", r"C:\home\me\AppData\Roaming"),
                ("TEMP", r"C:\home\me\AppData\Local\Temp"),
                ("SystemRoot", r"C:\Windows"),
                ("BACKPLANE_COMPANION_HOME", r"D:\bp"),
            ],
        );
        assert_eq!(
            names(&environment),
            [
                "USERPROFILE",
                "USERNAME",
                "LOCALAPPDATA",
                "APPDATA",
                "TEMP",
                "SystemRoot",
                "BACKPLANE_COMPANION_HOME",
                "PATH"
            ]
        );
        assert_eq!(
            value_of(&environment, "PATH").unwrap(),
            r"C:\Windows\System32;C:\Windows"
        );
    }

    #[test]
    fn companion_environment_on_windows_never_trusts_a_relative_system_root_or_data_dir() {
        let environment = environment_on(
            PlatformOs::Windows,
            &[
                ("USERPROFILE", r"C:\home\me"),
                ("SystemRoot", r"Windows"),
                ("PATH", r"C:\home\me\evil;C:\Windows"),
                ("BACKPLANE_COMPANION_HOME", "/bp"),
                ("HOME", "/home/me"),
            ],
        );
        assert_eq!(names(&environment), ["USERPROFILE", "PATH"]);
        assert_eq!(
            value_of(&environment, "PATH").unwrap(),
            r"C:\Windows\System32;C:\Windows"
        );
    }

    const SERVICE_OTHER_INSTALL: &str = r#"{"service":{"backend":"launchd","definition":"/h/Library/LaunchAgents/dev.backplane.companion.plist","installed":true,"current":false,"enabled":true,"running":true},"daemon_running":true}"#;
    const SERVICE_NONE: &str = r#"{"service":{"backend":"launchd","definition":"/h/Library/LaunchAgents/dev.backplane.companion.plist","installed":false,"current":false,"enabled":false,"running":false},"daemon_running":false}"#;
    const SERVICE_INSTALLED: &str = r#"{"service":{"backend":"launchd","definition":"/h/Library/LaunchAgents/dev.backplane.companion.plist","installed":true,"current":true,"enabled":true,"running":true},"daemon_running":true}"#;
    const AGENTS_STALE: &str = r#"[{"id":"claude-code","integration":{"state":"broken","config_path":"/h/.claude/settings.json","problems":["SessionStart:stale","Stop:stale"]}},{"id":"codex","integration":{"state":"installed","config_path":"/h/.codex/config.toml"}},{"id":"pi","integration":{"state":"broken","config_path":"/h/.pi/x.ts","problems":["companion_executable_missing"]}}]"#;
    const STATUS_ALL_AGENTS: &str =
        r#"{"connected":true,"capture":{"state":"active","enabled_agents":null}}"#;
    const AGENTS_PRESENCE: &str = r#"[{"id":"claude_code","presence":{"installed":true,"config_path":"/h/.claude/settings.json"}},{"id":"codex_cli","presence":{"installed":true,"config_path":"/h/.codex/config.toml"}},{"id":"pi_cli","presence":{"installed":false,"config_path":"/h/.pi"}}]"#;
    const AGENTS_INSTALLED: &str = r#"[{"id":"claude-code","integration":{"state":"installed","config_path":"/h/.claude/settings.json"},"action":""},{"id":"codex","integration":{"state":"installed","config_path":"/h/.codex/config.toml"}},{"id":"pi","integration":{"state":"installed","config_path":"/h/.pi/x.ts"}}]"#;

    type RecordedCall = (PathBuf, Vec<String>, Vec<(String, OsString)>);

    struct FakeCompanion {
        answers: HashMap<&'static str, CompanionOutput>,
        calls: RefCell<Vec<RecordedCall>>,
    }

    fn ok(stdout: &str) -> CompanionOutput {
        CompanionOutput {
            exit_code: Some(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: vec![],
        }
    }

    impl FakeCompanion {
        fn new(answers: &[(&'static str, CompanionOutput)]) -> Self {
            Self {
                answers: answers.iter().cloned().collect(),
                calls: RefCell::default(),
            }
        }

        fn steps(&self) -> Vec<String> {
            self.calls
                .borrow()
                .iter()
                .map(|(_, args, _)| args.join(" "))
                .collect()
        }
    }

    impl CompanionRunner for FakeCompanion {
        fn run(
            &self,
            program: &Path,
            args: &[&str],
            environment: &[(String, OsString)],
        ) -> std::io::Result<CompanionOutput> {
            let step = args.join(" ");
            self.calls.borrow_mut().push((
                program.to_path_buf(),
                args.iter().map(|arg| arg.to_string()).collect(),
                environment.to_vec(),
            ));
            Ok(self
                .answers
                .get(step.as_str())
                .cloned()
                .unwrap_or_else(|| panic!("unexpected companion call {step}")))
        }
    }

    const COMPANION: &str =
        "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion";

    #[test]
    fn enable_capture_repairs_hooks_then_installs_the_service() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("status", ok(STATUS_ALL_AGENTS)),
            ("agents status", ok(AGENTS_INSTALLED)),
            ("agents install", ok(AGENTS_INSTALLED)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let environment = vec![("HOME".to_string(), OsString::from("/h"))];
        let report = enable_capture(&companion, Path::new(COMPANION), &environment).unwrap();
        assert_eq!(
            companion.steps(),
            [
                "status",
                "agents status",
                "agents install",
                "service status",
                "service install"
            ]
        );
        for (program, _, passed) in companion.calls.borrow().iter() {
            assert_eq!(program, Path::new(COMPANION));
            assert_eq!(passed, &environment);
        }
        assert_eq!(report.companion_path, COMPANION);
        assert!(report.service.installed && report.service.current && report.daemon_running);
        assert!(!report.replaced_service);
        assert!(report.repaired_agents.is_empty());
        assert_eq!(report.agents.len(), 3);
    }

    #[test]
    fn enable_capture_migrates_an_existing_archive_install() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_OTHER_INSTALL)),
            ("status", ok(STATUS_ALL_AGENTS)),
            ("agents status", ok(AGENTS_STALE)),
            ("agents install", ok(AGENTS_INSTALLED)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let report = enable_capture(&companion, Path::new(COMPANION), &[]).unwrap();
        assert!(report.replaced_service);
        assert_eq!(report.repaired_agents, ["claude-code", "pi"]);
    }

    fn status_enabling(agents: &str) -> CompanionOutput {
        ok(&format!(
            r#"{{"connected":true,"capture":{{"state":"active","enabled_agents":{agents}}}}}"#
        ))
    }

    #[test]
    fn enable_capture_installs_only_the_enabled_agents_present_here() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("status", status_enabling(r#"["codex_cli","pi_cli"]"#)),
            ("agents status", ok(AGENTS_STALE)),
            ("agents list", ok(AGENTS_PRESENCE)),
            ("agents install codex_cli", ok(AGENTS_INSTALLED)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        enable_capture(&companion, Path::new(COMPANION), &[]).unwrap();
        assert_eq!(
            companion.steps(),
            [
                "status",
                "agents status",
                "agents list",
                "agents install codex_cli",
                "service status",
                "service install"
            ]
        );
    }

    #[test]
    fn enable_capture_reports_repairs_only_for_agents_it_installed() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("status", status_enabling(r#"["codex_cli"]"#)),
            (
                "agents status",
                ok(
                    r#"[{"id":"claude_code","integration":{"state":"broken","config_path":"/h/.claude/settings.json","problems":["Stop:stale"]}},{"id":"codex_cli","integration":{"state":"broken","config_path":"/h/.codex/hooks.json","problems":["Stop:stale"]}}]"#,
                ),
            ),
            ("agents list", ok(AGENTS_PRESENCE)),
            ("agents install codex_cli", ok(AGENTS_INSTALLED)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let report = enable_capture(&companion, Path::new(COMPANION), &[]).unwrap();
        assert_eq!(report.repaired_agents, ["codex_cli"]);
    }

    #[test]
    fn enable_capture_installs_no_hooks_when_no_agent_is_enabled() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("status", status_enabling("[]")),
            ("agents status", ok(AGENTS_STALE)),
            ("agents list", ok(AGENTS_PRESENCE)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let report = enable_capture(&companion, Path::new(COMPANION), &[]).unwrap();
        assert!(!companion
            .steps()
            .iter()
            .any(|step| step.starts_with("agents install")));
        assert!(report.repaired_agents.is_empty());
        assert_eq!(
            report.agents.len(),
            3,
            "the agents' state is still reported"
        );
    }

    #[test]
    fn enable_capture_never_passes_an_unknown_enabled_agent_as_an_argument() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            (
                "status",
                status_enabling(r#"["--purge","../x","claude_code","claude_code"]"#),
            ),
            ("agents status", ok(AGENTS_INSTALLED)),
            ("agents list", ok(AGENTS_PRESENCE)),
            ("agents install claude_code", ok(AGENTS_INSTALLED)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        enable_capture(&companion, Path::new(COMPANION), &[]).unwrap();
        assert!(companion
            .steps()
            .contains(&"agents install claude_code".to_string()));
    }

    #[test]
    fn enable_capture_stops_when_the_enabled_agents_cannot_be_read() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("status", ok(r#"{"capture":{}}"#)),
        ]);
        assert!(matches!(
            enable_capture(&companion, Path::new(COMPANION), &[]),
            Err(CaptureError::Protocol { step, .. }) if step == "status"
        ));
        assert_eq!(companion.steps(), ["status"]);
    }

    const UNINSTALLED: &str = r#"{"uninstalled":true,"server_revoked":true}"#;

    /// Records how many companion steps had run when it was turned off.
    struct FakeLoginItem<'a> {
        companion: &'a FakeCompanion,
        enabled: Cell<bool>,
        fail_disable: bool,
        disabled_after_steps: Cell<Option<usize>>,
    }

    impl<'a> FakeLoginItem<'a> {
        fn new(companion: &'a FakeCompanion, enabled: bool) -> Self {
            Self {
                companion,
                enabled: Cell::new(enabled),
                fail_disable: false,
                disabled_after_steps: Cell::default(),
            }
        }
    }

    impl LoginItem for FakeLoginItem<'_> {
        fn is_enabled(&self) -> Result<bool, String> {
            Ok(self.enabled.get())
        }
        fn enable(&self) -> Result<(), String> {
            unreachable!("removal never enables launch at login")
        }
        fn disable(&self) -> Result<(), String> {
            self.disabled_after_steps
                .set(Some(self.companion.calls.borrow().len()));
            if self.fail_disable {
                return Err("Operation not permitted".into());
            }
            self.enabled.set(false);
            Ok(())
        }
    }

    fn uninstalling_companion() -> FakeCompanion {
        FakeCompanion::new(&[
            ("agents uninstall", ok(AGENTS_INSTALLED)),
            ("service uninstall", ok(SERVICE_NONE)),
            ("uninstall --purge", ok(UNINSTALLED)),
        ])
    }

    #[test]
    fn companion_uninstall_removes_hooks_then_the_service_then_purges() {
        let companion = uninstalling_companion();
        let login_item = FakeLoginItem::new(&companion, false);
        let environment = vec![("HOME".to_string(), OsString::from("/h"))];
        let report =
            companion_uninstall(&companion, Path::new(COMPANION), &environment, &login_item)
                .unwrap();
        assert_eq!(
            companion.steps(),
            ["agents uninstall", "service uninstall", "uninstall --purge"]
        );
        for (program, _, passed) in companion.calls.borrow().iter() {
            assert_eq!(program, Path::new(COMPANION));
            assert_eq!(passed, &environment);
        }
        assert_eq!(
            report,
            UninstallReport {
                uninstalled: true,
                server_revoked: true
            }
        );
    }

    #[test]
    fn companion_uninstall_turns_off_launch_at_login_before_any_companion_step() {
        let companion = uninstalling_companion();
        let login_item = FakeLoginItem::new(&companion, true);
        companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).unwrap();
        assert!(!login_item.enabled.get());
        assert_eq!(login_item.disabled_after_steps.get(), Some(0));
        assert_eq!(companion.steps().len(), 3);
    }

    #[test]
    fn companion_uninstall_with_launch_at_login_already_off_never_disables() {
        let companion = uninstalling_companion();
        let login_item = FakeLoginItem::new(&companion, false);
        assert!(companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).is_ok());
        assert_eq!(login_item.disabled_after_steps.get(), None);
    }

    #[test]
    fn companion_uninstall_finishes_teardown_when_launch_at_login_cannot_be_turned_off() {
        let companion = uninstalling_companion();
        let login_item = FakeLoginItem {
            fail_disable: true,
            ..FakeLoginItem::new(&companion, true)
        };
        let error =
            companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).unwrap_err();
        assert!(
            matches!(&error, CaptureError::LoginItemFailed { message, .. } if message.contains("Operation not permitted")),
            "{error:?}"
        );
        assert!(
            matches!(&error, CaptureError::LoginItemFailed { report, .. } if *report == UninstallReport { uninstalled: true, server_revoked: true }),
            "the finished teardown's report survives: {error:?}"
        );
        assert_eq!(
            companion.steps(),
            ["agents uninstall", "service uninstall", "uninstall --purge"]
        );
    }

    #[test]
    fn companion_uninstall_reports_a_failed_companion_step_over_the_login_item() {
        let companion = FakeCompanion::new(&[(
            "agents uninstall",
            CompanionOutput {
                exit_code: Some(1),
                stdout: vec![],
                stderr: b"backplane-companion: permission denied\n".to_vec(),
            },
        )]);
        let login_item = FakeLoginItem {
            fail_disable: true,
            ..FakeLoginItem::new(&companion, true)
        };
        let error =
            companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).unwrap_err();
        assert!(
            matches!(&error, CaptureError::CompanionFailed { step, .. } if step == "agents uninstall"),
            "{error:?}"
        );
    }

    #[test]
    fn companion_uninstall_never_purges_after_a_failed_step() {
        let companion = FakeCompanion::new(&[
            ("agents uninstall", ok(AGENTS_INSTALLED)),
            (
                "service uninstall",
                CompanionOutput {
                    exit_code: Some(1),
                    stdout: vec![],
                    stderr: b"backplane-companion: foreign_definition\n".to_vec(),
                },
            ),
        ]);
        let login_item = FakeLoginItem::new(&companion, true);
        let error =
            companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).unwrap_err();
        assert!(
            matches!(&error, CaptureError::CompanionFailed { step, .. } if step == "service uninstall"),
            "{error:?}"
        );
        assert!(!companion.steps().contains(&"uninstall --purge".to_string()));
        assert!(
            !login_item.enabled.get(),
            "a halfway teardown still stops relaunching at login"
        );
    }

    fn failed(stderr: &str) -> CompanionOutput {
        CompanionOutput {
            exit_code: Some(1),
            stdout: vec![],
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    const DAEMON_OUTLIVED_STOP: &str = "backplane-companion: daemon_running: The running companion did not end its capture session in time. (service_daemon_still_running)\n";

    #[test]
    fn companion_uninstall_continues_to_the_purge_when_the_daemon_outlived_the_service_stop() {
        let companion = FakeCompanion::new(&[
            ("agents uninstall", ok(AGENTS_INSTALLED)),
            ("service uninstall", failed(DAEMON_OUTLIVED_STOP)),
            ("uninstall --purge", ok(UNINSTALLED)),
        ]);
        let login_item = FakeLoginItem::new(&companion, true);
        let report = companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item)
            .expect("the purge waits for the daemon itself");
        assert_eq!(
            companion.steps(),
            ["agents uninstall", "service uninstall", "uninstall --purge"]
        );
        assert!(report.uninstalled);
        assert_eq!(login_item.disabled_after_steps.get(), Some(0));
    }

    #[test]
    fn companion_uninstall_reports_the_purge_when_the_daemon_never_exits() {
        let companion = FakeCompanion::new(&[
            ("agents uninstall", ok(AGENTS_INSTALLED)),
            ("service uninstall", failed(DAEMON_OUTLIVED_STOP)),
            ("uninstall --purge", failed(DAEMON_OUTLIVED_STOP)),
        ]);
        let login_item = FakeLoginItem::new(&companion, true);
        let error =
            companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).unwrap_err();
        assert!(
            matches!(&error, CaptureError::CompanionFailed { step, message, .. } if step == "uninstall --purge" && message.starts_with("daemon_running:")),
            "{error:?}"
        );
    }

    #[test]
    fn companion_uninstall_still_stops_at_a_service_failure_that_merely_mentions_the_daemon() {
        let companion = FakeCompanion::new(&[
            ("agents uninstall", ok(AGENTS_INSTALLED)),
            (
                "service uninstall",
                failed(
                    "backplane-companion: service_definition_not_owned: daemon_running: not ours\n",
                ),
            ),
        ]);
        let login_item = FakeLoginItem::new(&companion, true);
        let error =
            companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item).unwrap_err();
        assert!(
            matches!(&error, CaptureError::CompanionFailed { step, .. } if step == "service uninstall"),
            "{error:?}"
        );
        assert!(!companion.steps().contains(&"uninstall --purge".to_string()));
    }

    #[test]
    fn companion_uninstall_rejects_output_it_cannot_read() {
        let companion = FakeCompanion::new(&[
            ("agents uninstall", ok(AGENTS_INSTALLED)),
            ("service uninstall", ok(SERVICE_NONE)),
            ("uninstall --purge", ok("{}")),
        ]);
        let login_item = FakeLoginItem::new(&companion, false);
        assert!(matches!(
            companion_uninstall(&companion, Path::new(COMPANION), &[], &login_item),
            Err(CaptureError::Protocol { step, .. }) if step == "uninstall --purge"
        ));
    }

    #[test]
    fn companion_for_removal_needs_the_binary_inside_applications() {
        let root = tempfile::tempdir().unwrap();
        let executable = bundle_executable(root.path(), "Backplane Companion.app");
        assert!(matches!(
            companion_for_removal_with(&MacosInstall::under(root.path()), &executable),
            Err(CaptureError::NotBundled { .. })
        ));
        std::fs::write(executable.with_file_name(COMPANION_BINARY), "").unwrap();
        assert_eq!(
            companion_for_removal_with(&MacosInstall::under(root.path()), &executable).unwrap(),
            executable.with_file_name(COMPANION_BINARY)
        );
        assert!(matches!(
            companion_for_removal_with(&*system_macos(), &executable),
            Err(CaptureError::NotInApplications { .. })
        ));
    }

    #[test]
    fn the_capture_commands_refuse_an_app_outside_applications() {
        for executable in [
            "/home/me/Downloads/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/home/me/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications Old/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications/../tmp/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications/backplane-companion-desktop",
        ] {
            let executable = Path::new(executable);
            assert!(
                matches!(
                    system_macos().trusted_companion(executable),
                    Err(CaptureError::NotInApplications { .. })
                ),
                "{executable:?}"
            );
            assert!(
                matches!(
                    companion_for_removal_with(&*system_macos(), executable),
                    Err(CaptureError::NotInApplications { .. })
                ),
                "{executable:?}"
            );
        }
    }

    #[test]
    fn companion_for_removal_follows_the_platform_install_policy() {
        let linux = install_policy_for(PlatformOs::Linux, |_| None);
        assert!(matches!(
            companion_for_removal_with(
                &*linux,
                Path::new("/usr/lib/backplane-companion/backplane-companion-desktop")
            ),
            Err(CaptureError::NotBundled { path }) if path == "/usr/lib/backplane-companion/backplane-companion"
        ));
        assert!(matches!(
            companion_for_removal_with(
                &*linux,
                Path::new("/home/me/.local/bin/backplane-companion-desktop")
            ),
            Err(CaptureError::NotInApplications { .. })
        ));
        let unknown = install_policy_for(PlatformOs::Unknown, |_| None);
        let (_root, executable) = installed_bundle();
        assert!(matches!(
            companion_for_removal_with(&*unknown, &executable),
            Err(CaptureError::NotInApplications { .. })
        ));
    }

    #[test]
    fn not_in_applications_serializes_with_its_kind() {
        let error = CaptureError::NotInApplications {
            path: "/home/me/Downloads/Backplane Companion.app".into(),
        };
        assert_eq!(
            serde_json::to_value(&error).unwrap()["kind"],
            "not_in_applications"
        );
    }

    #[test]
    fn enable_capture_stops_at_the_first_failing_step() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("status", ok(STATUS_ALL_AGENTS)),
            ("agents status", ok(AGENTS_INSTALLED)),
            (
                "agents install",
                CompanionOutput {
                    exit_code: Some(1),
                    stdout: vec![],
                    stderr: b"backplane-companion: the Claude Code settings are not valid JSON\n"
                        .to_vec(),
                },
            ),
        ]);
        let error = enable_capture(&companion, Path::new(COMPANION), &[]).unwrap_err();
        assert_eq!(
            error,
            CaptureError::CompanionFailed {
                step: "agents install".into(),
                exit_code: Some(1),
                message: "the Claude Code settings are not valid JSON".into(),
            }
        );
        assert!(!companion.steps().contains(&"service install".to_string()));
    }

    #[test]
    fn enable_capture_rejects_output_it_cannot_read() {
        let companion = FakeCompanion::new(&[("status", ok("not json"))]);
        assert!(matches!(
            enable_capture(&companion, Path::new(COMPANION), &[]),
            Err(CaptureError::Protocol { step, .. }) if step == "status"
        ));
    }

    #[test]
    fn start_companion_service_installs_only_the_service() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_NONE)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let environment = vec![("HOME".to_string(), OsString::from("/h"))];
        let report =
            start_companion_service(&companion, Path::new(COMPANION), &environment).unwrap();
        assert_eq!(companion.steps(), ["service status", "service install"]);
        for (_, _, passed) in companion.calls.borrow().iter() {
            assert_eq!(passed, &environment);
        }
        assert!(report.service.installed && report.daemon_running && !report.replaced_service);
        assert_eq!(report.companion_path, COMPANION);
    }

    #[test]
    fn start_companion_service_leaves_a_current_running_service_alone() {
        let companion = FakeCompanion::new(&[("service status", ok(SERVICE_INSTALLED))]);
        let report = start_companion_service(&companion, Path::new(COMPANION), &[]).unwrap();
        assert_eq!(companion.steps(), ["service status"]);
        assert!(report.service.running && report.daemon_running);
    }

    #[test]
    fn start_companion_service_replaces_a_service_for_another_install() {
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_OTHER_INSTALL)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let report = start_companion_service(&companion, Path::new(COMPANION), &[]).unwrap();
        assert!(report.replaced_service && report.service.current);
    }

    #[test]
    fn start_companion_service_restarts_a_current_service_that_is_not_running() {
        let stopped = SERVICE_INSTALLED.replace(
            r#""running":true},"daemon_running":true"#,
            r#""running":false},"daemon_running":false"#,
        );
        let companion = FakeCompanion::new(&[
            ("service status", ok(&stopped)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        start_companion_service(&companion, Path::new(COMPANION), &[]).unwrap();
        assert_eq!(companion.steps(), ["service status", "service install"]);
    }

    #[test]
    fn install_agent_hooks_never_touches_the_service() {
        let companion = FakeCompanion::new(&[
            ("status", ok(STATUS_ALL_AGENTS)),
            ("agents status", ok(AGENTS_STALE)),
            ("agents install", ok(AGENTS_INSTALLED)),
        ]);
        let report = install_agent_hooks(&companion, Path::new(COMPANION), &[]).unwrap();
        assert_eq!(
            companion.steps(),
            ["status", "agents status", "agents install"]
        );
        assert_eq!(report.repaired_agents, ["claude-code", "pi"]);
        assert_eq!(report.agents.len(), 3);
    }

    #[test]
    fn companion_failure_message_is_bounded() {
        let companion = FakeCompanion::new(&[(
            "status",
            CompanionOutput {
                exit_code: None,
                stdout: vec![],
                stderr: "x".repeat(10_000).into_bytes(),
            },
        )]);
        match enable_capture(&companion, Path::new(COMPANION), &[]).unwrap_err() {
            CaptureError::CompanionFailed {
                message, exit_code, ..
            } => {
                assert!(message.chars().count() <= MAX_MESSAGE_CHARS);
                assert_eq!(exit_code, None);
            }
            other => panic!("{other:?}"),
        }
    }

    fn installed_bundle() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let executable = bundle_executable(root.path(), "Backplane Companion.app");
        std::fs::write(executable.with_file_name(COMPANION_BINARY), "").unwrap();
        (root, executable)
    }

    #[test]
    fn repair_moved_service_reinstalls_a_launch_agent_for_another_path() {
        let (_root, executable) = installed_bundle();
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_OTHER_INSTALL)),
            ("service install", ok(SERVICE_INSTALLED)),
        ]);
        let environment = vec![("HOME".to_string(), OsString::from("/h"))];
        let repaired = repair_moved_service_with(
            &companion,
            &MacosInstall::under(_root.path()),
            &executable,
            &environment,
        )
        .unwrap()
        .expect("a moved app must be repaired");
        assert_eq!(companion.steps(), ["service status", "service install"]);
        for (program, _, passed) in companion.calls.borrow().iter() {
            assert_eq!(program, &executable.with_file_name(COMPANION_BINARY));
            assert_eq!(passed, &environment);
        }
        assert!(repaired.service.current && repaired.daemon_running);
    }

    #[test]
    fn repair_moved_service_leaves_a_current_service_alone() {
        let (_root, executable) = installed_bundle();
        let companion = FakeCompanion::new(&[("service status", ok(SERVICE_INSTALLED))]);
        assert_eq!(
            repair_moved_service_with(
                &companion,
                &MacosInstall::under(_root.path()),
                &executable,
                &[]
            )
            .unwrap(),
            None
        );
        assert_eq!(companion.steps(), ["service status"]);
    }

    #[test]
    fn repair_moved_service_never_enables_capture_that_is_off() {
        let (_root, executable) = installed_bundle();
        let companion = FakeCompanion::new(&[("service status", ok(SERVICE_NONE))]);
        assert_eq!(
            repair_moved_service_with(
                &companion,
                &MacosInstall::under(_root.path()),
                &executable,
                &[]
            )
            .unwrap(),
            None
        );
        assert_eq!(companion.steps(), ["service status"]);
    }

    #[test]
    fn repair_moved_service_skips_dmg_and_translocated_apps() {
        for prefix in [
            "/Volumes/Backplane Companion",
            "/private/var/folders/x/AppTranslocation/ABC/d",
        ] {
            let companion = FakeCompanion::new(&[]);
            let executable = PathBuf::from(prefix)
                .join("Backplane Companion.app/Contents/MacOS/backplane-companion-desktop");
            assert_eq!(
                repair_moved_service_with(&companion, &*system_macos(), &executable, &[]).unwrap(),
                None,
                "{prefix}"
            );
            assert!(companion.steps().is_empty(), "{prefix}");
        }
    }

    #[test]
    fn repair_moved_service_skips_an_app_outside_applications() {
        let (_root, executable) = installed_bundle();
        let companion = FakeCompanion::new(&[]);
        assert_eq!(
            repair_moved_service_with(&companion, &*system_macos(), &executable, &[]).unwrap(),
            None
        );
        assert!(companion.steps().is_empty());
    }

    #[test]
    fn repair_moved_service_skips_a_build_without_a_bundled_companion() {
        let root = tempfile::tempdir().unwrap();
        let executable = bundle_executable(root.path(), "Backplane Companion.app");
        let companion = FakeCompanion::new(&[]);
        assert_eq!(
            repair_moved_service_with(
                &companion,
                &MacosInstall::under(root.path()),
                &executable,
                &[]
            )
            .unwrap(),
            None
        );
        assert!(companion.steps().is_empty());
    }

    #[test]
    fn repair_moved_service_reports_a_failed_reinstall() {
        let (_root, executable) = installed_bundle();
        let companion = FakeCompanion::new(&[
            ("service status", ok(SERVICE_OTHER_INSTALL)),
            (
                "service install",
                CompanionOutput {
                    exit_code: Some(1),
                    stdout: vec![],
                    stderr: b"backplane-companion: launchctl bootstrap failed\n".to_vec(),
                },
            ),
        ]);
        assert!(matches!(
            repair_moved_service_with(&companion, &MacosInstall::under(_root.path()), &executable, &[]),
            Err(CaptureError::CompanionFailed { step, .. }) if step == "service install"
        ));
    }
}
