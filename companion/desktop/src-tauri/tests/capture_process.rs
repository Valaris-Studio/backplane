// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

#![cfg(unix)]
//! Runs enable_capture through the real process runner against a stand-in
//! companion script, under a temporary HOME: nothing reaches launchd or the
//! real ~/Library/LaunchAgents.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use backplane_companion_desktop_lib::capture::{
    companion_environment, enable_capture, start_companion_service, CaptureError, ProcessRunner,
    COMPANION_BINARY,
};

const STAND_IN: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$HOME/calls.log"
env | sort > "$HOME/env-$1-$2.txt"
case "$1 $2" in
  "service status") echo '{"service":{"backend":"launchd","definition":"'"$HOME"'/Library/LaunchAgents/dev.backplane.companion.plist","installed":false,"current":false,"enabled":false,"running":false},"daemon_running":false}' ;;
  "service install") echo '{"service":{"backend":"launchd","definition":"'"$HOME"'/Library/LaunchAgents/dev.backplane.companion.plist","installed":true,"current":true,"enabled":true,"running":true},"daemon_running":true}' ;;
  "agents status"|"agents install") echo '[]' ;;
  "status ") echo '{"connected":false,"capture":{"state":"not_connected","enabled_agents":null}}' ;;
  *) echo "backplane-companion: unexpected $*" >&2; exit 1 ;;
esac
"#;

fn stand_in_bundle(root: &Path, script: &str) -> PathBuf {
    let macos = root
        .join("Backplane Companion.app")
        .join("Contents")
        .join("MacOS");
    std::fs::create_dir_all(&macos).unwrap();
    let companion = macos.join(COMPANION_BINARY);
    std::fs::write(&companion, script).unwrap();
    std::fs::set_permissions(&companion, std::fs::Permissions::from_mode(0o755)).unwrap();
    companion
}

fn temporary_home() -> (tempfile::TempDir, Vec<(String, OsString)>) {
    let home = tempfile::tempdir().unwrap();
    let environment = companion_environment(|name| match name {
        "HOME" => Some(home.path().as_os_str().to_owned()),
        "USER" => Some("tester".into()),
        "BACKPLANE_BEACON_ARTIFACT" => Some("/tmp/leak/artifact.json".into()),
        _ => None,
    });
    (home, environment)
}

#[test]
fn enable_capture_runs_the_bundled_companion_with_only_the_given_environment() {
    let root = tempfile::tempdir().unwrap();
    let companion = stand_in_bundle(root.path(), STAND_IN);
    let (home, environment) = temporary_home();

    let report = enable_capture(&ProcessRunner, &companion, &environment).unwrap();

    assert!(report.service.installed && report.daemon_running);
    assert_eq!(report.companion_path, companion.to_string_lossy());
    let calls = std::fs::read_to_string(home.path().join("calls.log")).unwrap();
    assert_eq!(
        calls.lines().collect::<Vec<_>>(),
        [
            "status",
            "agents status",
            "agents install",
            "service status",
            "service install"
        ]
    );
    let child_env = std::fs::read_to_string(home.path().join("env-service-install.txt")).unwrap();
    let names: Vec<&str> = child_env
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name))
        .filter(|name| !["PWD", "SHLVL", "_", "OLDPWD"].contains(name))
        .collect();
    assert_eq!(names, ["HOME", "PATH", "USER"]);
    assert!(!child_env.contains("/tmp/leak"));
    assert!(
        !home.path().join("Library").exists(),
        "the stand-in must not have been replaced by a real install"
    );
}

#[test]
fn start_companion_service_reports_a_failing_companion_with_its_message() {
    let root = tempfile::tempdir().unwrap();
    let companion = stand_in_bundle(
        root.path(),
        "#!/bin/sh\necho 'backplane-companion: launchctl refused the agent' >&2\nexit 3\n",
    );
    let (_home, environment) = temporary_home();

    let error = start_companion_service(&ProcessRunner, &companion, &environment).unwrap_err();

    assert_eq!(
        error,
        CaptureError::CompanionFailed {
            step: "service status".into(),
            exit_code: Some(3),
            message: "launchctl refused the agent".into(),
        }
    );
}

#[test]
fn start_companion_service_reports_a_companion_that_cannot_start() {
    let root = tempfile::tempdir().unwrap();
    let (_home, environment) = temporary_home();
    let missing = root.path().join(COMPANION_BINARY);

    let error = start_companion_service(&ProcessRunner, &missing, &environment).unwrap_err();

    assert!(
        matches!(&error, CaptureError::CompanionFailed { step, exit_code: None, .. } if step == "service status"),
        "{error:?}"
    );
}
