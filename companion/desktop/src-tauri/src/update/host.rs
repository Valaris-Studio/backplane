// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The real side effects behind the update flow: the updater plugin, the
//! bundled companion CLI, the daemon's control API and the bundle on disk.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;
use serde_json::Value;

use super::flow::{BundleTrust, Bundles, Clock, Companion, ServiceSnapshot};
#[cfg(target_os = "macos")]
use super::{flow::UpdatePackage, UpdateError};
use crate::capture::{self, ProcessRunner, ServiceReport};
use crate::daemon::types::AgentEntry;
use crate::daemon::DaemonClient;

/// Hook states `agents install` repairs in place. An agent the user turned
/// off (`not_installed`) stays off; `invalid_config` needs the user first.
const REPAIRABLE_AGENT_STATES: &[&str] = &["installed", "broken", "needs_trust"];

#[cfg(target_os = "macos")]
pub struct PluginPackage(pub tauri_plugin_updater::Update);

#[cfg(target_os = "macos")]
fn is_signature_failure(error: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error;
    matches!(
        error,
        Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::SignedVersionMismatch { .. }
            | Error::MissingSignedVersion
    )
}

#[cfg(target_os = "macos")]
impl UpdatePackage for PluginPackage {
    fn version(&self) -> &str {
        &self.0.version
    }

    fn download_verified(&self) -> Result<Vec<u8>, UpdateError> {
        tauri::async_runtime::block_on(self.0.download(|_, _| {}, || {})).map_err(|error| {
            let message = error.to_string();
            if is_signature_failure(&error) {
                UpdateError::Signature { message }
            } else {
                UpdateError::Download { message }
            }
        })
    }

    fn install(&self, archive: &[u8]) -> Result<(), UpdateError> {
        self.0
            .install(archive)
            .map_err(|error| UpdateError::Install {
                message: error.to_string(),
            })
    }
}

/// The companion at the bundle's fixed path: after a swap or a rollback it
/// is whichever build now sits there.
pub struct BundledCompanion {
    pub companion: PathBuf,
    pub environment: Vec<(String, OsString)>,
    pub daemon: DaemonClient,
}

#[derive(Deserialize)]
struct CompanionVersion {
    version: String,
}

impl BundledCompanion {
    fn run<T: serde::de::DeserializeOwned>(&self, args: &[&str]) -> Result<T, String> {
        capture::run_step(&ProcessRunner, &self.companion, &self.environment, args)
            .map_err(|error| error.to_string())
    }
}

pub fn agents_to_repair(agents: &[AgentEntry]) -> Vec<String> {
    agents
        .iter()
        .filter(|agent| {
            agent.integration.as_ref().is_some_and(|integration| {
                REPAIRABLE_AGENT_STATES.contains(&integration.state.as_str())
            })
        })
        .map(|agent| agent.id.clone())
        .collect()
}

impl Companion for BundledCompanion {
    fn service_status(&self) -> Result<ServiceSnapshot, String> {
        let report: ServiceReport = self.run(&["service", "status"])?;
        Ok(ServiceSnapshot {
            installed: report.service.installed,
            daemon_running: report.daemon_running,
        })
    }

    fn service_stop(&self) -> Result<(), String> {
        self.run::<Value>(&["service", "stop"]).map(drop)
    }

    fn service_start(&self) -> Result<(), String> {
        self.run::<Value>(&["service", "start"]).map(drop)
    }

    fn service_install(&self) -> Result<(), String> {
        self.run::<Value>(&["service", "install"]).map(drop)
    }

    fn agents_install(&self) -> Result<(), String> {
        let agents: Vec<AgentEntry> = self.run(&["agents", "status"])?;
        let repair = agents_to_repair(&agents);
        if repair.is_empty() {
            return Ok(());
        }
        let mut args = vec!["agents", "install"];
        args.extend(repair.iter().map(String::as_str));
        self.run::<Value>(&args).map(drop)
    }

    fn companion_version(&self) -> Result<String, String> {
        self.run::<CompanionVersion>(&["version"])
            .map(|report| report.version)
    }

    fn daemon_version(&self) -> Option<String> {
        tauri::async_runtime::block_on(self.daemon.version())
            .ok()
            .map(|report| report.version)
    }
}

/// Only ever touches a real directory named `<something>.app.previous` that
/// the current user owns, so neither a bad argument nor a planted symlink can
/// redirect a delete, copy or rename onto the live bundle or anything else.
/// The rollback copy as checked: its identity, re-checked right before each
/// mutation so a swap between the check and the act is refused.
struct PinnedCopy {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl PinnedCopy {
    #[cfg(not(unix))]
    fn still_at(&self, _path: &Path) -> std::io::Result<()> {
        Err(rollback_copies_unsupported())
    }

    #[cfg(unix)]
    fn still_at(&self, path: &Path) -> std::io::Result<()> {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.dev() != self.device
            || metadata.ino() != self.inode
        {
            return Err(std::io::Error::other(format!(
                "{} changed after it was checked",
                path.display()
            )));
        }
        Ok(())
    }
}

/// In-app updates swap a macOS bundle (D6: no updater elsewhere), so no
/// other platform ever has a rollback copy to vouch for.
#[cfg(not(unix))]
fn rollback_copies_unsupported() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "rollback copies exist only for macOS bundles",
    )
}

#[cfg(not(unix))]
fn ensure_rollback_copy(_path: &Path, _must_exist: bool) -> std::io::Result<Option<PinnedCopy>> {
    Err(rollback_copies_unsupported())
}

/// `None` when it is absent and may be.
#[cfg(unix)]
fn ensure_rollback_copy(path: &Path, must_exist: bool) -> std::io::Result<Option<PinnedCopy>> {
    use super::PREVIOUS_SUFFIX;
    use std::os::unix::fs::MetadataExt;
    let refuse = |why: &str| {
        Err(std::io::Error::other(format!(
            "refusing {} as a rollback copy: {why}",
            path.display()
        )))
    };
    let named_as_copy = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(&format!(".app{PREVIOUS_SUFFIX}")));
    if !named_as_copy {
        return refuse("not named <app>.app.previous");
    }
    let metadata = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !must_exist => {
            return Ok(None)
        }
        Err(error) => return Err(error),
        Ok(metadata) => metadata,
    };
    if metadata.file_type().is_symlink() {
        return refuse("it is a symlink");
    }
    if !metadata.is_dir() {
        return refuse("it is not a directory");
    }
    // SAFETY: getuid has no preconditions and cannot fail.
    let current_user = unsafe { libc::getuid() };
    if metadata.uid() != current_user {
        return refuse("another user owns it");
    }
    Ok(Some(PinnedCopy {
        device: metadata.dev(),
        inode: metadata.ino(),
    }))
}

/// Removes whatever sits at `path` without following a symlink there.
fn remove_without_following(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
    }
}

pub struct DiskBundles;

impl Bundles for DiskBundles {
    fn keep_previous(&self, app_bundle: &Path, previous: &Path) -> std::io::Result<()> {
        if let Some(pinned) = ensure_rollback_copy(previous, false)? {
            pinned.still_at(previous)?;
            std::fs::remove_dir_all(previous)?;
        }
        // ditto keeps the code signature, extended attributes and symlinks.
        let status = Command::new("/usr/bin/ditto")
            .arg(app_bundle)
            .arg(previous)
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!("ditto exited with {status}")))
        }
    }

    fn restore_previous(&self, app_bundle: &Path, previous: &Path) -> std::io::Result<()> {
        let pinned = ensure_rollback_copy(previous, true)?
            .ok_or_else(|| std::io::Error::other("no rollback copy"))?;
        remove_without_following(app_bundle)?;
        pinned.still_at(previous)?;
        std::fs::rename(previous, app_bundle)?;
        // rename keeps the inode: anything else there now was swapped in.
        pinned.still_at(app_bundle)
    }

    fn discard_previous(&self, previous: &Path) -> std::io::Result<()> {
        let pinned = ensure_rollback_copy(previous, true)?
            .ok_or_else(|| std::io::Error::other("no rollback copy"))?;
        pinned.still_at(previous)?;
        std::fs::remove_dir_all(previous)
    }

    fn exists(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok()
    }
}

/// The Developer ID team every release is signed by.
pub const RELEASE_TEAM_ID: &str = "D7C2NKCLQZ";

/// The `TeamIdentifier=` line of `codesign -dv`; ad hoc builds say "not set".
pub fn team_identifier(codesign_details: &str) -> Option<&str> {
    codesign_details
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|team| !team.is_empty() && *team != "not set")
}

pub fn evaluate_signature(
    verified: Result<(), String>,
    codesign_details: &str,
    expected_team: &str,
) -> Result<(), String> {
    verified?;
    match team_identifier(codesign_details) {
        Some(team) if team == expected_team => Ok(()),
        Some(team) => Err(format!("signed by team {team}, expected {expected_team}")),
        None => Err(format!("not signed by a team, expected {expected_team}")),
    }
}

/// A bundle may replace the live app only with an intact seal
/// (`codesign --verify --deep --strict`) from the release team.
pub struct CodesignTrust {
    pub expected_team: &'static str,
}

fn codesign(args: &[&str], bundle: &Path) -> Result<String, String> {
    let output = Command::new("/usr/bin/codesign")
        .args(args)
        .arg(bundle)
        .output()
        .map_err(|error| error.to_string())?;
    // codesign reports on stderr, for success and failure alike.
    let report = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(report)
    } else {
        Err(report)
    }
}

impl BundleTrust for CodesignTrust {
    fn verify(&self, bundle: &Path) -> Result<(), String> {
        let verified = codesign(&["--verify", "--deep", "--strict"], bundle).map(drop);
        let details = codesign(&["-dv"], bundle).unwrap_or_default();
        evaluate_signature(verified, &details, self.expected_team)
    }
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn unix_seconds(&self) -> u64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default()
    }
}

// The bundle swap and its rollback copies are macOS-only (unix metadata).
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn agents(json: &str) -> Vec<AgentEntry> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn agents_to_repair_keeps_agents_the_user_turned_off_off() {
        let listed = agents(
            r#"[{"id":"claude-code","integration":{"state":"installed","config_path":"/h/a"}},
                {"id":"codex","integration":{"state":"not_installed","config_path":"/h/b"}},
                {"id":"pi","integration":{"state":"broken","config_path":"/h/c","problems":["companion_executable_missing"]}},
                {"id":"gemini","integration":{"state":"invalid_config","config_path":"/h/d"}},
                {"id":"opencode"}]"#,
        );
        assert_eq!(agents_to_repair(&listed), ["claude-code", "pi"]);
    }

    const DETAILS_SIGNED: &str = "Executable=/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop
Identifier=dev.backplane.companion.desktop
Format=app bundle with Mach-O universal (x86_64 arm64)
Authority=Developer ID Application: EXAMPLE DEVELOPER (D7C2NKCLQZ)
TeamIdentifier=D7C2NKCLQZ
Sealed Resources version=2 rules=13 files=40
";
    const DETAILS_AD_HOC: &str = "Identifier=dev.backplane.companion.desktop
Signature=adhoc
TeamIdentifier=not set
";

    #[test]
    fn team_identifier_reads_codesign_details() {
        assert_eq!(team_identifier(DETAILS_SIGNED), Some("D7C2NKCLQZ"));
        assert_eq!(team_identifier(DETAILS_AD_HOC), None);
        assert_eq!(team_identifier(""), None);
    }

    #[test]
    fn evaluate_signature_needs_a_valid_seal_and_the_release_team() {
        assert_eq!(
            evaluate_signature(Ok(()), DETAILS_SIGNED, RELEASE_TEAM_ID),
            Ok(())
        );
        assert!(evaluate_signature(
            Err("a sealed resource is missing or invalid".into()),
            DETAILS_SIGNED,
            RELEASE_TEAM_ID
        )
        .unwrap_err()
        .contains("sealed resource"));
        assert!(evaluate_signature(Ok(()), DETAILS_AD_HOC, RELEASE_TEAM_ID).is_err());
        assert!(evaluate_signature(Ok(()), DETAILS_SIGNED, "OTHERTEAM1").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codesign_trust_refuses_an_unsigned_bundle() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("Backplane Companion.app.previous");
        std::fs::create_dir_all(previous.join("Contents/MacOS")).unwrap();
        std::fs::write(previous.join("Contents/MacOS/x"), "tampered").unwrap();
        let trust = CodesignTrust {
            expected_team: RELEASE_TEAM_ID,
        };
        assert!(trust.verify(&previous).is_err());
    }

    fn planted_symlink() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Backplane Companion.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(app.join("Contents/live"), "live").unwrap();
        let target = root.path().join("precious");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("data"), "keep me").unwrap();
        let previous = super::super::previous_bundle_of(&app);
        std::os::unix::fs::symlink(&target, &previous).unwrap();
        (root, app, previous, target)
    }

    #[test]
    fn disk_bundles_refuse_a_symlinked_rollback_copy() {
        let (_root, app, previous, target) = planted_symlink();
        assert!(DiskBundles.discard_previous(&previous).is_err());
        assert!(DiskBundles.restore_previous(&app, &previous).is_err());
        assert!(DiskBundles.keep_previous(&app, &previous).is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("data")).unwrap(),
            "keep me"
        );
        assert!(std::fs::symlink_metadata(&previous)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/live")).unwrap(),
            "live"
        );
    }

    #[test]
    fn disk_bundles_refuse_a_rollback_copy_that_is_not_a_directory() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Backplane Companion.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        let previous = super::super::previous_bundle_of(&app);
        std::fs::write(&previous, "a file").unwrap();
        assert!(DiskBundles.discard_previous(&previous).is_err());
        assert!(DiskBundles.restore_previous(&app, &previous).is_err());
        assert!(DiskBundles.keep_previous(&app, &previous).is_err());
        assert_eq!(std::fs::read_to_string(&previous).unwrap(), "a file");
        assert!(app.join("Contents").is_dir());
    }

    #[test]
    fn disk_bundles_refuse_to_delete_anything_but_a_rollback_copy() {
        let root = tempfile::tempdir().unwrap();
        let live = root.path().join("Backplane Companion.app");
        std::fs::create_dir_all(live.join("Contents")).unwrap();
        assert!(DiskBundles.discard_previous(&live).is_err());
        assert!(DiskBundles.restore_previous(&live, &live).is_err());
        assert!(live.join("Contents").is_dir());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn disk_bundles_keep_restore_and_discard_the_previous_bundle() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Backplane Companion.app");
        let binary = app.join("Contents/MacOS/backplane-companion");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, "old").unwrap();
        let previous = super::super::previous_bundle_of(&app);

        DiskBundles.keep_previous(&app, &previous).unwrap();
        std::fs::write(&binary, "new").unwrap();
        assert_eq!(
            std::fs::read_to_string(previous.join("Contents/MacOS/backplane-companion")).unwrap(),
            "old"
        );

        DiskBundles.restore_previous(&app, &previous).unwrap();
        assert_eq!(std::fs::read_to_string(&binary).unwrap(), "old");
        assert!(!previous.exists());

        DiskBundles.keep_previous(&app, &previous).unwrap();
        DiskBundles.discard_previous(&previous).unwrap();
        assert!(!previous.exists());
        assert!(binary.is_file());
    }

    #[test]
    fn pinned_rollback_copy_notices_a_swap_for_another_directory() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("Backplane Companion.app.previous");
        std::fs::create_dir_all(&previous).unwrap();
        let pinned = ensure_rollback_copy(&previous, true)
            .unwrap()
            .expect("a copy");
        assert!(pinned.still_at(&previous).is_ok());
        // Moved aside, not removed: a removed directory's inode can be handed
        // straight to the decoy (seen on Linux tmpfs), which would pass as the original.
        std::fs::rename(&previous, root.path().join("original")).unwrap();
        let decoy = root.path().join("decoy");
        std::fs::create_dir_all(&decoy).unwrap();
        std::fs::rename(&decoy, &previous).unwrap();
        assert!(pinned.still_at(&previous).is_err());
    }

    #[test]
    fn pinned_rollback_copy_notices_a_swap_for_a_symlink() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("Backplane Companion.app.previous");
        std::fs::create_dir_all(&previous).unwrap();
        let pinned = ensure_rollback_copy(&previous, true)
            .unwrap()
            .expect("a copy");
        let moved = root.path().join("moved");
        std::fs::rename(&previous, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &previous).unwrap();
        assert!(pinned.still_at(&previous).is_err());
    }

    #[test]
    fn restore_previous_replaces_a_symlinked_app_without_following_it() {
        let root = tempfile::tempdir().unwrap();
        let victim = root.path().join("victim");
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("data"), "keep me").unwrap();
        let app = root.path().join("Backplane Companion.app");
        std::os::unix::fs::symlink(&victim, &app).unwrap();
        let previous = super::super::previous_bundle_of(&app);
        std::fs::create_dir_all(previous.join("Contents")).unwrap();
        std::fs::write(previous.join("Contents/marker"), "previous").unwrap();

        DiskBundles.restore_previous(&app, &previous).unwrap();

        assert_eq!(
            std::fs::read_to_string(victim.join("data")).unwrap(),
            "keep me"
        );
        let restored = std::fs::symlink_metadata(&app).unwrap();
        assert!(restored.is_dir() && !restored.file_type().is_symlink());
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/marker")).unwrap(),
            "previous"
        );
    }

    #[test]
    fn exists_sees_a_symlinked_rollback_copy_without_following_it() {
        let (_root, _app, previous, target) = planted_symlink();
        std::fs::remove_dir_all(&target).unwrap();
        assert!(
            DiskBundles.exists(&previous),
            "a dangling link is still there"
        );
        assert!(!DiskBundles.exists(&previous.with_extension("absent")));
    }

    #[test]
    fn restore_previous_without_a_copy_leaves_the_app_alone() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("Backplane Companion.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        let previous = super::super::previous_bundle_of(&app);
        assert!(DiskBundles.restore_previous(&app, &previous).is_err());
        assert!(app.join("Contents").is_dir());
    }
}
