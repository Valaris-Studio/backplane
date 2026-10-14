// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The update state machine. Everything with a side effect sits behind a
//! trait so the whole sequence, including rollback, runs against fakes.
//!
//! Install: download + verify → stop the daemon (its queue and ack ledger
//! persist on disk) → keep the current bundle as `<app>.previous` → journal
//! → swap → the caller relaunches. The next launch finishes it: reinstall
//! the service and hooks from the new bundle, then wait for the app, the
//! companion CLI and the daemon to report the same version, or roll back.
//! Nothing here takes the companion's data directory: the swap cannot touch
//! captured data.

use std::path::Path;
use std::time::{Duration, Instant};

use super::{
    previous_bundle_of, PendingUpdate, UpdateError, UpdateFailed, UpdateFailureReason,
    UpdateJournal,
};

/// How long the new daemon has to report the new version after a relaunch.
pub const HEALTH_DEADLINE: Duration = Duration::from_secs(60);
pub const HEALTH_POLL_INTERVAL: Duration = Duration::from_secs(2);
/// A stopping daemon flushes its queue first; the swap waits for that so two
/// daemons never drain the same queue.
pub const DAEMON_STOP_DEADLINE: Duration = Duration::from_secs(20);
pub const DAEMON_STOP_POLL_INTERVAL: Duration = Duration::from_millis(500);

pub trait UpdatePackage {
    fn version(&self) -> &str;
    /// Downloads the archive and verifies its signature against the pinned key.
    fn download_verified(&self) -> Result<Vec<u8>, UpdateError>;
    /// Replaces the app bundle with the verified archive's.
    fn install(&self, archive: &[u8]) -> Result<(), UpdateError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceSnapshot {
    pub installed: bool,
    pub daemon_running: bool,
}

/// The bundled companion at the app's fixed path, whichever bundle currently
/// sits there.
pub trait Companion {
    fn service_status(&self) -> Result<ServiceSnapshot, String>;
    fn service_stop(&self) -> Result<(), String>;
    fn service_start(&self) -> Result<(), String>;
    fn service_install(&self) -> Result<(), String>;
    fn agents_install(&self) -> Result<(), String>;
    fn companion_version(&self) -> Result<String, String>;
    fn daemon_version(&self) -> Option<String>;
}

pub trait Bundles {
    fn keep_previous(&self, app_bundle: &Path, previous: &Path) -> std::io::Result<()>;
    fn restore_previous(&self, app_bundle: &Path, previous: &Path) -> std::io::Result<()>;
    fn discard_previous(&self, previous: &Path) -> std::io::Result<()>;
    fn exists(&self, path: &Path) -> bool;
}

/// Whether a bundle may replace the live app: in production, a valid
/// Developer ID signature from the release team.
pub trait BundleTrust {
    fn verify(&self, bundle: &Path) -> Result<(), String>;
}

pub trait Clock {
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
    fn unix_seconds(&self) -> u64;
}

pub struct Installation<'a> {
    pub app_bundle: &'a Path,
    pub running_version: &'a str,
    pub journal: &'a UpdateJournal,
}

pub struct UpdateEffects<'a> {
    pub companion: &'a dyn Companion,
    pub bundles: &'a dyn Bundles,
    pub clock: &'a dyn Clock,
    pub trust: &'a dyn BundleTrust,
}

/// Returns once the new bundle is in place; the caller relaunches.
pub fn install_update(
    package: &dyn UpdatePackage,
    effects: &UpdateEffects,
    installation: &Installation,
) -> Result<(), UpdateError> {
    // A bad signature fails here, before anything on disk or in launchd moves.
    let archive = package.download_verified()?;
    let service_installed = stop_daemon(effects)?;
    let previous_bundle = previous_bundle_of(installation.app_bundle);
    if let Err(error) = effects
        .bundles
        .keep_previous(installation.app_bundle, &previous_bundle)
    {
        discard_quietly(effects, &previous_bundle);
        restart_daemon(effects, service_installed);
        return Err(UpdateError::KeepPrevious {
            message: error.to_string(),
        });
    }
    let pending = PendingUpdate {
        from_version: installation.running_version.to_string(),
        to_version: package.version().to_string(),
        app_bundle: installation.app_bundle.to_path_buf(),
        previous_bundle: previous_bundle.clone(),
        service_installed,
    };
    if let Err(error) = installation.journal.write_pending(&pending) {
        discard_quietly(effects, &previous_bundle);
        restart_daemon(effects, service_installed);
        return Err(UpdateError::Install {
            message: format!("could not record the update: {error}"),
        });
    }
    if let Err(error) = package.install(&archive) {
        // The swap may have failed halfway; the kept copy is the known state,
        // but only a copy that still verifies may replace the live app.
        match effects.trust.verify(&previous_bundle) {
            Err(untrusted) => {
                log::error!("update: not restoring an untrusted rollback copy: {untrusted}")
            }
            Ok(()) => {
                if let Err(restore) = effects
                    .bundles
                    .restore_previous(installation.app_bundle, &previous_bundle)
                {
                    log::error!("update: restoring the previous app failed: {restore}");
                }
            }
        }
        let _ = installation.journal.clear_pending();
        restart_daemon(effects, service_installed);
        return Err(error);
    }
    Ok(())
}

/// Stops an installed service and waits until its daemon has exited (and so
/// flushed its queue). Returns whether a service was installed.
fn stop_daemon(effects: &UpdateEffects) -> Result<bool, UpdateError> {
    let capture_error = |message: String| UpdateError::Capture { message };
    let status = effects.companion.service_status().map_err(capture_error)?;
    if !status.installed {
        return Ok(false);
    }
    effects.companion.service_stop().map_err(capture_error)?;
    let deadline = effects.clock.now() + DAEMON_STOP_DEADLINE;
    loop {
        let status = effects.companion.service_status().map_err(capture_error)?;
        if !status.daemon_running {
            return Ok(true);
        }
        if effects.clock.now() >= deadline {
            restart_daemon(effects, true);
            return Err(capture_error(format!(
                "the daemon was still running after {} s",
                DAEMON_STOP_DEADLINE.as_secs()
            )));
        }
        effects.clock.sleep(DAEMON_STOP_POLL_INTERVAL);
    }
}

fn restart_daemon(effects: &UpdateEffects, service_installed: bool) {
    if service_installed {
        if let Err(error) = effects.companion.service_start() {
            log::error!("update: restarting the capture service failed: {error}");
        }
    }
}

fn discard_quietly(effects: &UpdateEffects, previous_bundle: &Path) {
    if effects.bundles.exists(previous_bundle) {
        if let Err(error) = effects.bundles.discard_previous(previous_bundle) {
            log::warn!("update: removing the rollback copy failed: {error}");
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum LaunchOutcome {
    Updated {
        version: String,
    },
    /// `restored` means the previous bundle is back in place and the app must
    /// relaunch into it.
    RolledBack {
        failure: UpdateFailed,
        restored: bool,
    },
}

pub fn finish_pending_update(
    effects: &UpdateEffects,
    installation: &Installation,
) -> Option<LaunchOutcome> {
    let pending = installation.journal.pending()?;
    if installation.running_version != pending.to_version {
        return Some(roll_back(
            effects,
            installation,
            &pending,
            UpdateFailureReason::AppVersionMismatch,
            format!(
                "the relaunched app reports {} instead of {}",
                installation.running_version, pending.to_version
            ),
        ));
    }
    if pending.service_installed {
        // `service install` is a no-op for an unchanged, loaded definition, so
        // the stopped daemon needs an explicit start.
        let refreshed = effects
            .companion
            .service_install()
            .map_err(|error| format!("service install: {error}"))
            .and_then(|()| {
                effects
                    .companion
                    .agents_install()
                    .map_err(|error| format!("agents install: {error}"))
            })
            .and_then(|()| {
                effects
                    .companion
                    .service_start()
                    .map_err(|error| format!("service start: {error}"))
            });
        if let Err(detail) = refreshed {
            return Some(roll_back(
                effects,
                installation,
                &pending,
                UpdateFailureReason::RefreshFailed,
                detail,
            ));
        }
    }
    if let Err(detail) = await_matching_versions(effects, &pending) {
        return Some(roll_back(
            effects,
            installation,
            &pending,
            UpdateFailureReason::Unhealthy,
            detail,
        ));
    }
    discard_quietly(effects, &pending.previous_bundle);
    if let Err(error) = installation.journal.clear_pending() {
        log::warn!("update: clearing the update journal failed: {error}");
    }
    Some(LaunchOutcome::Updated {
        version: pending.to_version,
    })
}

/// The app, the bundled companion and (with capture on) the daemon must all
/// report the new version before the deadline.
fn await_matching_versions(effects: &UpdateEffects, pending: &PendingUpdate) -> Result<(), String> {
    let expected = pending.to_version.as_str();
    let deadline = effects.clock.now() + HEALTH_DEADLINE;
    loop {
        let companion = effects.companion.companion_version();
        let daemon = pending
            .service_installed
            .then(|| effects.companion.daemon_version());
        let companion_matches = companion.as_deref() == Ok(expected);
        let daemon_matches = daemon
            .as_ref()
            .is_none_or(|version| version.as_deref() == Some(expected));
        if companion_matches && daemon_matches {
            return Ok(());
        }
        if effects.clock.now() >= deadline {
            let seconds = HEALTH_DEADLINE.as_secs();
            return Err(if !companion_matches {
                format!(
                    "the bundled companion reports {} instead of {expected}",
                    companion.unwrap_or_else(|error| error)
                )
            } else {
                format!("the daemon did not report {expected} within {seconds} s")
            });
        }
        effects.clock.sleep(HEALTH_POLL_INTERVAL);
    }
}

/// The failure is journaled before anything moves, so a crash mid-rollback
/// never loops back into another attempt. A rollback copy that no longer
/// verifies (tampered while the new version ran) is never restored: the
/// current app and service stay as they are.
fn roll_back(
    effects: &UpdateEffects,
    installation: &Installation,
    pending: &PendingUpdate,
    reason: UpdateFailureReason,
    detail: String,
) -> LaunchOutcome {
    log::error!(
        "update to {} failed ({reason:?}): {detail}",
        pending.to_version
    );
    let has_copy = effects.bundles.exists(&pending.previous_bundle);
    let untrusted = if has_copy {
        effects.trust.verify(&pending.previous_bundle).err()
    } else {
        None
    };
    let failure = UpdateFailed {
        from_version: pending.from_version.clone(),
        to_version: pending.to_version.clone(),
        reason: if untrusted.is_some() {
            UpdateFailureReason::RollbackCopyUntrusted
        } else {
            reason
        },
        detail: match &untrusted {
            Some(error) => format!("{detail}; the rollback copy does not verify: {error}"),
            None => detail,
        },
        failed_at_unix: effects.clock.unix_seconds(),
    };
    if let Err(error) = installation.journal.record_failure(&failure) {
        log::error!("update: recording the failure failed: {error}");
    }
    if let Err(error) = installation.journal.clear_pending() {
        log::error!("update: clearing the update journal failed: {error}");
    }
    if untrusted.is_some() {
        return LaunchOutcome::RolledBack {
            failure,
            restored: false,
        };
    }
    let restored = has_copy
        && match effects
            .bundles
            .restore_previous(&pending.app_bundle, &pending.previous_bundle)
        {
            Ok(()) => true,
            Err(error) => {
                log::error!("update: restoring the previous app failed: {error}");
                false
            }
        };
    if pending.service_installed {
        // The restored bundle sits at the same path: reinstall from it.
        if let Err(error) = effects.companion.service_install() {
            log::error!("update: reinstalling the previous service failed: {error}");
        }
        restart_daemon(effects, true);
    }
    LaunchOutcome::RolledBack { failure, restored }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;

    const APP: &str = "Backplane Companion.app";

    #[derive(Default)]
    struct Steps(RefCell<Vec<String>>);

    impl Steps {
        fn push(&self, step: impl Into<String>) {
            self.0.borrow_mut().push(step.into());
        }
        fn list(&self) -> Vec<String> {
            self.0.borrow().clone()
        }
        fn contains(&self, step: &str) -> bool {
            self.0.borrow().iter().any(|recorded| recorded == step)
        }
    }

    struct FakePackage<'a> {
        steps: &'a Steps,
        version: String,
        download: Result<Vec<u8>, UpdateError>,
        install: Result<(), UpdateError>,
        /// What the swap writes into the bundle, standing in for the new app.
        new_marker: Option<PathBuf>,
    }

    impl UpdatePackage for FakePackage<'_> {
        fn version(&self) -> &str {
            &self.version
        }
        fn download_verified(&self) -> Result<Vec<u8>, UpdateError> {
            self.steps.push("download");
            self.download.clone()
        }
        fn install(&self, archive: &[u8]) -> Result<(), UpdateError> {
            self.steps.push(format!("install {}", archive.len()));
            if let Some(marker) = &self.new_marker {
                let contents = match self.install {
                    Ok(()) => self.version.as_str(),
                    Err(_) => "half-swapped",
                };
                std::fs::write(marker, contents).unwrap();
            }
            self.install.clone()
        }
    }

    struct FakeCompanion<'a> {
        steps: &'a Steps,
        installed: bool,
        daemon_running: Cell<bool>,
        /// The daemon ignores SIGTERM (it never reports stopped).
        stuck: bool,
        fail: Option<&'static str>,
        companion_version: RefCell<String>,
        /// What the daemon reports after each poll, in order; the last repeats.
        daemon_versions: RefCell<Vec<Option<String>>>,
    }

    impl<'a> FakeCompanion<'a> {
        fn new(steps: &'a Steps, installed: bool) -> Self {
            Self {
                steps,
                installed,
                daemon_running: Cell::new(installed),
                stuck: false,
                fail: None,
                companion_version: RefCell::new("0.2.0".into()),
                daemon_versions: RefCell::new(vec![Some("0.2.0".into())]),
            }
        }

        fn step(&self, name: &'static str) -> Result<(), String> {
            self.steps.push(name);
            if self.fail == Some(name) {
                return Err(format!("{name} failed"));
            }
            Ok(())
        }
    }

    impl Companion for FakeCompanion<'_> {
        fn service_status(&self) -> Result<ServiceSnapshot, String> {
            self.step("service status")?;
            Ok(ServiceSnapshot {
                installed: self.installed,
                daemon_running: self.daemon_running.get(),
            })
        }
        fn service_stop(&self) -> Result<(), String> {
            self.step("service stop")?;
            if !self.stuck {
                self.daemon_running.set(false);
            }
            Ok(())
        }
        fn service_start(&self) -> Result<(), String> {
            self.step("service start")?;
            self.daemon_running.set(true);
            Ok(())
        }
        fn service_install(&self) -> Result<(), String> {
            self.step("service install")
        }
        fn agents_install(&self) -> Result<(), String> {
            self.step("agents install")
        }
        fn companion_version(&self) -> Result<String, String> {
            self.step("companion version")?;
            Ok(self.companion_version.borrow().clone())
        }
        fn daemon_version(&self) -> Option<String> {
            self.steps.push("daemon version");
            let mut versions = self.daemon_versions.borrow_mut();
            if versions.len() > 1 {
                versions.remove(0)
            } else {
                versions[0].clone()
            }
        }
    }

    /// Real directory moves, so a test can see exactly what changed on disk.
    struct DiskBundles<'a> {
        steps: &'a Steps,
        fail_keep: bool,
    }

    impl Bundles for DiskBundles<'_> {
        fn keep_previous(&self, app_bundle: &Path, previous: &Path) -> std::io::Result<()> {
            self.steps.push("keep previous");
            if self.fail_keep {
                return Err(std::io::Error::other("disk full"));
            }
            copy_tree(app_bundle, previous)
        }
        fn restore_previous(&self, app_bundle: &Path, previous: &Path) -> std::io::Result<()> {
            self.steps.push("restore previous");
            if app_bundle.exists() {
                std::fs::remove_dir_all(app_bundle)?;
            }
            std::fs::rename(previous, app_bundle)
        }
        fn discard_previous(&self, previous: &Path) -> std::io::Result<()> {
            self.steps.push("discard previous");
            std::fs::remove_dir_all(previous)
        }
        fn exists(&self, path: &Path) -> bool {
            path.exists()
        }
    }

    fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_tree(&entry.path(), &target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    }

    struct FakeClock {
        start: Instant,
        elapsed: Cell<Duration>,
    }

    impl FakeClock {
        fn new() -> Self {
            Self {
                start: Instant::now(),
                elapsed: Cell::new(Duration::ZERO),
            }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            self.start + self.elapsed.get()
        }
        fn sleep(&self, duration: Duration) {
            self.elapsed.set(self.elapsed.get() + duration);
        }
        fn unix_seconds(&self) -> u64 {
            1_790_000_000
        }
    }

    /// An installed app next to the companion's data directory, holding a
    /// queue and ack ledger the update must never touch.
    struct Machine {
        _root: tempfile::TempDir,
        app_bundle: PathBuf,
        data_dir: PathBuf,
        journal: UpdateJournal,
    }

    impl Machine {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let app_bundle = root.path().join("Applications").join(APP);
            let macos = app_bundle.join("Contents").join("MacOS");
            std::fs::create_dir_all(&macos).unwrap();
            std::fs::write(macos.join("backplane-companion"), "0.1.0").unwrap();
            let data_dir = root.path().join("home").join(".backplane-companion");
            std::fs::create_dir_all(data_dir.join("queue")).unwrap();
            std::fs::write(data_dir.join("queue").join("0001.json"), "{\"event\":1}").unwrap();
            std::fs::write(data_dir.join("acks.jsonl"), "0001\n").unwrap();
            let journal = UpdateJournal::new(root.path().join("config"));
            Self {
                _root: root,
                app_bundle,
                data_dir,
                journal,
            }
        }

        fn installation<'a>(&'a self, running_version: &'a str) -> Installation<'a> {
            Installation {
                app_bundle: &self.app_bundle,
                running_version,
                journal: &self.journal,
            }
        }

        fn companion_bytes(&self) -> String {
            std::fs::read_to_string(self.app_bundle.join("Contents/MacOS/backplane-companion"))
                .unwrap()
        }

        fn previous(&self) -> PathBuf {
            previous_bundle_of(&self.app_bundle)
        }

        fn data_snapshot(&self) -> BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)> {
            let mut snapshot = BTreeMap::new();
            snapshot_tree(&self.data_dir, &mut snapshot);
            snapshot
        }

        fn package<'a>(&self, steps: &'a Steps) -> FakePackage<'a> {
            FakePackage {
                steps,
                version: "0.2.0".into(),
                download: Ok(b"archive".to_vec()),
                install: Ok(()),
                new_marker: Some(self.app_bundle.join("Contents/MacOS/backplane-companion")),
            }
        }
    }

    fn snapshot_tree(
        directory: &Path,
        snapshot: &mut BTreeMap<PathBuf, (Vec<u8>, std::time::SystemTime)>,
    ) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            if metadata.is_dir() {
                snapshot_tree(&entry.path(), snapshot);
            } else {
                snapshot.insert(
                    entry.path(),
                    (
                        std::fs::read(entry.path()).unwrap(),
                        metadata.modified().unwrap(),
                    ),
                );
            }
        }
    }

    fn effects<'a>(
        companion: &'a FakeCompanion,
        bundles: &'a DiskBundles,
        clock: &'a FakeClock,
    ) -> UpdateEffects<'a> {
        UpdateEffects {
            companion,
            bundles,
            clock,
            trust: &Trusted,
        }
    }

    struct Trusted;

    impl BundleTrust for Trusted {
        fn verify(&self, _bundle: &Path) -> Result<(), String> {
            Ok(())
        }
    }

    struct RecordingTrust<'a> {
        steps: &'a Steps,
        trusted: bool,
    }

    impl BundleTrust for RecordingTrust<'_> {
        fn verify(&self, bundle: &Path) -> Result<(), String> {
            self.steps.push(format!(
                "verify {}",
                bundle.file_name().unwrap().to_string_lossy()
            ));
            if self.trusted {
                Ok(())
            } else {
                Err("code object is not signed at all".into())
            }
        }
    }

    fn unhealthy_launch(machine: &Machine, trusted: bool) -> (Steps, LaunchOutcome) {
        installed_update(machine, true);
        let steps = Steps::default();
        let outcome = {
            let companion = FakeCompanion::new(&steps, true);
            *companion.daemon_versions.borrow_mut() = vec![None];
            let bundles = DiskBundles {
                steps: &steps,
                fail_keep: false,
            };
            let clock = FakeClock::new();
            let trust = RecordingTrust {
                steps: &steps,
                trusted,
            };
            let effects = UpdateEffects {
                companion: &companion,
                bundles: &bundles,
                clock: &clock,
                trust: &trust,
            };
            finish_pending_update(&effects, &machine.installation("0.2.0")).unwrap()
        };
        (steps, outcome)
    }

    #[test]
    fn finish_pending_update_restores_a_previous_bundle_that_verifies() {
        let machine = Machine::new();
        let (steps, outcome) = unhealthy_launch(&machine, true);
        assert!(matches!(
            outcome,
            LaunchOutcome::RolledBack { restored: true, .. }
        ));
        let verify = format!("verify {APP}.previous");
        let tail: Vec<String> = steps
            .list()
            .into_iter()
            .skip_while(|step| *step != verify)
            .collect();
        assert_eq!(
            tail,
            [
                verify.as_str(),
                "restore previous",
                "service install",
                "service start"
            ]
        );
        assert_eq!(machine.companion_bytes(), "0.1.0");
    }

    #[test]
    fn finish_pending_update_keeps_the_current_app_when_the_rollback_copy_is_untrusted() {
        let machine = Machine::new();
        let (steps, outcome) = unhealthy_launch(&machine, false);
        let LaunchOutcome::RolledBack { failure, restored } = outcome else {
            panic!("expected a rollback outcome, got {outcome:?}");
        };
        assert!(!restored);
        assert_eq!(failure.reason, UpdateFailureReason::RollbackCopyUntrusted);
        assert!(failure.detail.contains("not signed"), "{}", failure.detail);
        assert_eq!(machine.journal.last_failure(), Some(failure));
        assert_eq!(machine.journal.pending(), None);
        assert_eq!(machine.companion_bytes(), "0.2.0");
        let after_verify: Vec<String> = steps
            .list()
            .into_iter()
            .skip_while(|step| !step.starts_with("verify"))
            .skip(1)
            .collect();
        assert!(after_verify.is_empty(), "{after_verify:?}");
    }

    #[test]
    fn install_update_does_not_restore_an_untrusted_copy_after_a_failed_swap() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = FakePackage {
            install: Err(UpdateError::Install {
                message: "rename failed".into(),
            }),
            ..machine.package(&steps)
        };
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let trust = RecordingTrust {
            steps: &steps,
            trusted: false,
        };
        let effects = UpdateEffects {
            companion: &companion,
            bundles: &bundles,
            clock: &clock,
            trust: &trust,
        };
        let result = install_update(&package, &effects, &machine.installation("0.1.0"));
        assert!(matches!(result, Err(UpdateError::Install { .. })));
        assert!(!steps.contains("restore previous"));
        assert_eq!(machine.companion_bytes(), "half-swapped");
    }

    #[test]
    fn install_update_with_a_bad_signature_changes_nothing() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = FakePackage {
            download: Err(UpdateError::Signature {
                message: "signature mismatch".into(),
            }),
            ..machine.package(&steps)
        };
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let result = install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        );
        assert!(matches!(result, Err(UpdateError::Signature { .. })));
        assert_eq!(steps.list(), ["download"]);
        assert_eq!(machine.companion_bytes(), "0.1.0");
        assert!(!machine.previous().exists());
        assert_eq!(machine.journal.pending(), None);
    }

    #[test]
    fn install_update_stops_the_daemon_keeps_the_previous_bundle_then_swaps() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = machine.package(&steps);
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        )
        .unwrap();
        assert_eq!(
            steps.list(),
            [
                "download",
                "service status",
                "service stop",
                "service status",
                "keep previous",
                "install 7"
            ]
        );
        assert_eq!(machine.companion_bytes(), "0.2.0");
        assert_eq!(
            std::fs::read_to_string(
                machine
                    .previous()
                    .join("Contents/MacOS/backplane-companion")
            )
            .unwrap(),
            "0.1.0"
        );
        assert_eq!(
            machine.journal.pending(),
            Some(PendingUpdate {
                from_version: "0.1.0".into(),
                to_version: "0.2.0".into(),
                app_bundle: machine.app_bundle.clone(),
                previous_bundle: machine.previous(),
                service_installed: true,
            })
        );
    }

    #[test]
    fn install_update_without_capture_never_touches_the_service() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = machine.package(&steps);
        let companion = FakeCompanion::new(&steps, false);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        )
        .unwrap();
        assert!(!steps.contains("service stop"));
        assert!(!machine.journal.pending().unwrap().service_installed);
    }

    #[test]
    fn install_update_aborts_when_the_daemon_does_not_stop() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = machine.package(&steps);
        let companion = FakeCompanion {
            stuck: true,
            ..FakeCompanion::new(&steps, true)
        };
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let result = install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        );
        assert!(matches!(result, Err(UpdateError::Capture { .. })));
        assert!(clock.elapsed.get() >= DAEMON_STOP_DEADLINE);
        assert!(!steps.contains("keep previous"));
        assert!(steps.list().iter().all(|step| !step.starts_with("install")));
        assert_eq!(machine.companion_bytes(), "0.1.0");
        assert_eq!(machine.journal.pending(), None);
    }

    #[test]
    fn install_update_restarts_capture_when_the_rollback_copy_fails() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = machine.package(&steps);
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: true,
        };
        let clock = FakeClock::new();
        let result = install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        );
        assert!(matches!(result, Err(UpdateError::KeepPrevious { .. })));
        assert_eq!(steps.list().last().unwrap(), "service start");
        assert!(steps.list().iter().all(|step| !step.starts_with("install")));
        assert_eq!(machine.companion_bytes(), "0.1.0");
        assert_eq!(machine.journal.pending(), None);
    }

    #[test]
    fn install_update_restores_the_previous_bundle_when_the_swap_fails() {
        let machine = Machine::new();
        let steps = Steps::default();
        let package = FakePackage {
            install: Err(UpdateError::Install {
                message: "rename failed".into(),
            }),
            ..machine.package(&steps)
        };
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let result = install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        );
        assert!(matches!(result, Err(UpdateError::Install { .. })));
        let after_swap: Vec<String> = steps
            .list()
            .into_iter()
            .skip_while(|step| !step.starts_with("install"))
            .skip(1)
            .collect();
        assert_eq!(after_swap, ["restore previous", "service start"]);
        assert_eq!(machine.companion_bytes(), "0.1.0");
        assert!(!machine.previous().exists());
        assert_eq!(machine.journal.pending(), None);
    }

    fn installed_update(machine: &Machine, service_installed: bool) {
        let steps = Steps::default();
        let package = machine.package(&steps);
        let companion = FakeCompanion::new(&steps, service_installed);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        install_update(
            &package,
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        )
        .unwrap();
    }

    #[test]
    fn finish_pending_update_without_a_pending_update_does_nothing() {
        let machine = Machine::new();
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        assert_eq!(
            finish_pending_update(
                &effects(&companion, &bundles, &clock),
                &machine.installation("0.1.0")
            ),
            None
        );
        assert!(steps.list().is_empty());
    }

    #[test]
    fn finish_pending_update_refreshes_capture_and_confirms_equal_versions() {
        let machine = Machine::new();
        installed_update(&machine, true);
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, true);
        *companion.daemon_versions.borrow_mut() =
            vec![None, Some("0.1.0".into()), Some("0.2.0".into())];
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.2.0"),
        );
        assert_eq!(
            outcome,
            Some(LaunchOutcome::Updated {
                version: "0.2.0".into()
            })
        );
        assert_eq!(
            steps.list()[..3],
            ["service install", "agents install", "service start"]
        );
        assert_eq!(steps.list().last().unwrap(), "discard previous");
        assert!(!machine.previous().exists());
        assert_eq!(machine.journal.pending(), None);
        assert_eq!(machine.journal.last_failure(), None);
        assert!(clock.elapsed.get() < HEALTH_DEADLINE);
    }

    #[test]
    fn finish_pending_update_without_capture_checks_only_the_companion() {
        let machine = Machine::new();
        installed_update(&machine, false);
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, false);
        *companion.daemon_versions.borrow_mut() = vec![None];
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.2.0"),
        );
        assert!(matches!(outcome, Some(LaunchOutcome::Updated { .. })));
        for step in [
            "service install",
            "agents install",
            "service start",
            "daemon version",
        ] {
            assert!(!steps.contains(step), "{step}");
        }
    }

    #[test]
    fn finish_pending_update_rolls_back_when_the_daemon_stays_unhealthy() {
        let machine = Machine::new();
        installed_update(&machine, true);
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, true);
        *companion.daemon_versions.borrow_mut() = vec![None];
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.2.0"),
        )
        .unwrap();
        assert!(clock.elapsed.get() >= HEALTH_DEADLINE);
        let LaunchOutcome::RolledBack { failure, restored } = outcome else {
            panic!("expected a rollback, got {outcome:?}");
        };
        assert!(restored);
        assert_eq!(failure.from_version, "0.1.0");
        assert_eq!(failure.to_version, "0.2.0");
        assert_eq!(failure.reason, UpdateFailureReason::Unhealthy);
        assert!(failure.detail.contains("daemon"), "{}", failure.detail);
        assert_eq!(machine.journal.last_failure(), Some(failure));
        assert_eq!(machine.journal.pending(), None);
        assert_eq!(machine.companion_bytes(), "0.1.0");
        assert!(!machine.previous().exists());
        let after_restore: Vec<String> = steps
            .list()
            .into_iter()
            .skip_while(|step| step != "restore previous")
            .collect();
        assert_eq!(
            after_restore,
            ["restore previous", "service install", "service start"]
        );
    }

    #[test]
    fn finish_pending_update_rolls_back_on_a_companion_version_mismatch() {
        let machine = Machine::new();
        installed_update(&machine, true);
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, true);
        *companion.companion_version.borrow_mut() = "0.1.9".into();
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.2.0"),
        );
        assert!(matches!(
            outcome,
            Some(LaunchOutcome::RolledBack { restored: true, .. })
        ));
        assert_eq!(machine.companion_bytes(), "0.1.0");
    }

    #[test]
    fn finish_pending_update_rolls_back_when_the_refresh_fails() {
        let machine = Machine::new();
        installed_update(&machine, true);
        let steps = Steps::default();
        let companion = FakeCompanion {
            fail: Some("agents install"),
            ..FakeCompanion::new(&steps, true)
        };
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.2.0"),
        )
        .unwrap();
        let LaunchOutcome::RolledBack { failure, restored } = outcome else {
            panic!("expected a rollback, got {outcome:?}");
        };
        assert!(restored);
        assert_eq!(failure.reason, UpdateFailureReason::RefreshFailed);
        assert!(
            failure.detail.contains("agents install"),
            "{}",
            failure.detail
        );
        assert!(!steps.contains("companion version"));
    }

    #[test]
    fn finish_pending_update_rolls_back_when_the_app_is_not_the_new_version() {
        let machine = Machine::new();
        installed_update(&machine, true);
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        )
        .unwrap();
        assert!(matches!(
            outcome,
            LaunchOutcome::RolledBack { restored: true, .. }
        ));
        assert!(!steps.contains("agents install"));
        assert_eq!(steps.list()[0], "restore previous");
        assert_eq!(machine.companion_bytes(), "0.1.0");
        assert_eq!(machine.journal.pending(), None);
        assert!(machine.journal.last_failure().is_some());
    }

    #[test]
    fn finish_pending_update_after_an_interrupted_rollback_only_records_it() {
        let machine = Machine::new();
        installed_update(&machine, true);
        std::fs::remove_dir_all(machine.previous()).unwrap();
        let steps = Steps::default();
        let companion = FakeCompanion::new(&steps, true);
        let bundles = DiskBundles {
            steps: &steps,
            fail_keep: false,
        };
        let clock = FakeClock::new();
        let outcome = finish_pending_update(
            &effects(&companion, &bundles, &clock),
            &machine.installation("0.1.0"),
        )
        .unwrap();
        assert!(matches!(
            outcome,
            LaunchOutcome::RolledBack {
                restored: false,
                ..
            }
        ));
        assert!(!steps.contains("restore previous"));
        assert_eq!(machine.journal.pending(), None);
    }

    #[test]
    fn update_flow_never_touches_the_companion_data_dir() {
        for daemon_healthy in [true, false] {
            let machine = Machine::new();
            let before = machine.data_snapshot();
            installed_update(&machine, true);
            let steps = Steps::default();
            let companion = FakeCompanion::new(&steps, true);
            if !daemon_healthy {
                *companion.daemon_versions.borrow_mut() = vec![None];
            }
            let bundles = DiskBundles {
                steps: &steps,
                fail_keep: false,
            };
            let clock = FakeClock::new();
            finish_pending_update(
                &effects(&companion, &bundles, &clock),
                &machine.installation("0.2.0"),
            )
            .unwrap();
            assert_eq!(machine.data_snapshot(), before, "healthy={daemon_healthy}");
            let journal_dir = machine.journal.directory();
            assert!(!journal_dir.starts_with(&machine.data_dir));
        }
    }
}
