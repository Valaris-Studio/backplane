// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Signed in-app updates. The updater plugin is Rust-only: the webview gets
//! five typed commands (check, install, last result, channel get/set) and never the
//! plugin's own IPC surface, so it cannot pick an endpoint, a key or a file.

pub mod commands;
pub mod flow;
pub mod host;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::platform::{platform_info_for, PlatformOs};

pub const RELEASES_URL: &str =
    "https://storage.googleapis.com/backplane-artifacts/companion-desktop";
const SETTINGS_FILE: &str = "update.json";
const PENDING_FILE: &str = "update-pending.json";
const FAILED_FILE: &str = "update-failed.json";
const OFFERED_FILE: &str = "update-offered.json";
/// The rollback copy sits beside the bundle, on the same volume, so restoring
/// it is a rename and never a cross-device copy.
pub(crate) const PREVIOUS_SUFFIX: &str = ".previous";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    pub fn endpoint(self) -> url::Url {
        let name = self.name();
        url::Url::parse(&format!("{RELEASES_URL}/{name}/latest.json"))
            .expect("the release URL is a constant")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Type, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateError {
    #[error("no update is available")]
    NoUpdate,
    #[error("an update is already being installed")]
    Busy,
    #[error("could not check for updates: {message}")]
    Check { message: String },
    #[error("the update could not be downloaded: {message}")]
    Download { message: String },
    #[error("the update is not signed by Backplane: {message}")]
    Signature { message: String },
    #[error("the capture service could not be stopped: {message}")]
    Capture { message: String },
    #[error("the current app could not be kept for rollback: {message}")]
    KeepPrevious { message: String },
    #[error("the update could not be installed: {message}")]
    Install { message: String },
    #[error("the update settings could not be saved: {message}")]
    Settings { message: String },
    #[error("updates need the app bundle: {message}")]
    NotBundled { message: String },
    /// Only macOS has the signed bundle swap; elsewhere the installer updates the app.
    #[error("in-app updates are not available on this platform")]
    UpdatesUnavailableOnPlatform,
    /// The build carries no updater public key, so no update could be verified.
    #[error("this build has no update signing key")]
    UpdatesNotConfigured,
}

/// Runs an update step only where in-app updates exist. Elsewhere nothing
/// runs: no download, no codesign check, no bundle swap.
pub fn when_updates_supported<T>(
    os: PlatformOs,
    step: impl FnOnce() -> Result<T, UpdateError>,
) -> Result<T, UpdateError> {
    if platform_info_for(os).updates_supported {
        step()
    } else {
        Err(UpdateError::UpdatesUnavailableOnPlatform)
    }
}

/// Whether the updater plugin's config names a public key. Without one the
/// plugin would still fetch the manifest and fail only when verifying the
/// download, so the app never asks at all.
pub fn updater_key_configured(updater_config: Option<&serde_json::Value>) -> bool {
    updater_config
        .and_then(|config| config.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|pubkey| !pubkey.trim().is_empty())
}

/// `when_updates_supported`, and also never without an updater key.
pub fn when_updates_allowed<T>(
    os: PlatformOs,
    key_configured: bool,
    step: impl FnOnce() -> Result<T, UpdateError>,
) -> Result<T, UpdateError> {
    when_updates_supported(os, || {
        if key_configured {
            step()
        } else {
            Err(UpdateError::UpdatesNotConfigured)
        }
    })
}

/// The in-flight update, written just before the bundle is swapped and read
/// by the next launch to finish (or roll back) the update.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingUpdate {
    pub from_version: String,
    pub to_version: String,
    pub app_bundle: PathBuf,
    pub previous_bundle: PathBuf,
    /// Only a service that was installed is reinstalled: an update never
    /// turns capture on.
    pub service_installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UpdateFailureReason {
    AppVersionMismatch,
    RefreshFailed,
    Unhealthy,
    RollbackCopyUntrusted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UpdateFailed {
    pub from_version: String,
    pub to_version: String,
    pub reason: UpdateFailureReason,
    pub detail: String,
    pub failed_at_unix: u64,
}

/// Newer than what runs, and never below a version this channel already
/// announced: a replayed or frozen manifest cannot walk a client back.
pub fn offer_is_acceptable(running: &str, offered: &str, highest_seen: Option<&str>) -> bool {
    let (Ok(running), Ok(offered)) = (
        semver::Version::parse(running),
        semver::Version::parse(offered),
    ) else {
        return false;
    };
    let at_least_highest = highest_seen
        .and_then(|highest| semver::Version::parse(highest).ok())
        .is_none_or(|highest| offered >= highest);
    offered > running && at_least_highest
}

/// Replaces the home directory with `~` wherever it appears as a whole path
/// component, so a failure shown in the UI carries no user name.
fn redact_home(text: &str, home: &Path) -> String {
    let home = home.to_string_lossy();
    let home = home.trim_end_matches('/');
    if home.is_empty() {
        return text.to_string();
    }
    let mut redacted = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(home) {
        let after = &rest[index + home.len()..];
        let whole_component = after
            .chars()
            .next()
            .is_none_or(|next| !(next.is_alphanumeric() || matches!(next, '-' | '_' | '.')));
        redacted.push_str(&rest[..index]);
        redacted.push_str(if whole_component { "~" } else { home });
        rest = after;
    }
    redacted.push_str(rest);
    redacted
}

pub fn previous_bundle_of(app_bundle: &Path) -> PathBuf {
    let mut name = app_bundle.file_name().unwrap_or_default().to_os_string();
    name.push(PREVIOUS_SUFFIX);
    app_bundle.with_file_name(name)
}

/// The update settings and journal, in the app's config directory (never the
/// companion's data directory, which holds the capture queue).
#[derive(Debug, Clone)]
pub struct UpdateJournal {
    directory: PathBuf,
}

impl UpdateJournal {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn channel(&self) -> UpdateChannel {
        #[derive(Deserialize)]
        struct Settings {
            channel: UpdateChannel,
        }
        // An unreadable or unknown setting must never block updates.
        self.read::<Settings>(SETTINGS_FILE)
            .map(|settings| settings.channel)
            .unwrap_or_default()
    }

    pub fn set_channel(&self, channel: UpdateChannel) -> Result<UpdateChannel, UpdateError> {
        self.write(SETTINGS_FILE, &serde_json::json!({ "channel": channel }))
            .map_err(|error| UpdateError::Settings {
                message: error.to_string(),
            })?;
        Ok(channel)
    }

    pub fn pending(&self) -> Option<PendingUpdate> {
        self.read(PENDING_FILE)
    }

    pub fn write_pending(&self, pending: &PendingUpdate) -> std::io::Result<()> {
        self.write(PENDING_FILE, pending)
    }

    pub fn clear_pending(&self) -> std::io::Result<()> {
        match std::fs::remove_file(self.directory.join(PENDING_FILE)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    pub fn last_failure(&self) -> Option<UpdateFailed> {
        self.read(FAILED_FILE)
    }

    pub fn record_failure(&self, failure: &UpdateFailed) -> std::io::Result<()> {
        self.write(FAILED_FILE, failure)
    }

    pub fn last_update_result(&self, home: &Path) -> Option<UpdateFailed> {
        self.last_failure().map(|failure| UpdateFailed {
            detail: redact_home(&failure.detail, home),
            ..failure
        })
    }

    pub fn highest_offered(&self, channel: UpdateChannel) -> Option<String> {
        self.read::<std::collections::BTreeMap<String, String>>(OFFERED_FILE)?
            .remove(channel.name())
    }

    /// Raises the channel's highest-seen version; lower or unparsable
    /// versions leave it unchanged.
    pub fn record_offered(&self, channel: UpdateChannel, version: &str) -> std::io::Result<()> {
        let Ok(offered) = semver::Version::parse(version) else {
            return Ok(());
        };
        let mut highest: std::collections::BTreeMap<String, String> =
            self.read(OFFERED_FILE).unwrap_or_default();
        let is_higher = highest
            .get(channel.name())
            .and_then(|seen| semver::Version::parse(seen).ok())
            .is_none_or(|seen| offered > seen);
        if !is_higher {
            return Ok(());
        }
        highest.insert(channel.name().to_string(), version.to_string());
        self.write(OFFERED_FILE, &highest)
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn read<T: serde::de::DeserializeOwned>(&self, name: &str) -> Option<T> {
        let bytes = std::fs::read(self.directory.join(name)).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// Write-then-rename, so a crash never leaves a half-written journal.
    fn write(&self, name: &str, value: &impl Serialize) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.directory)?;
        let target = self.directory.join(name);
        let staging = self.directory.join(format!(".{name}.tmp"));
        std::fs::write(&staging, serde_json::to_vec_pretty(value)?)?;
        std::fs::rename(staging, target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal() -> (tempfile::TempDir, UpdateJournal) {
        let root = tempfile::tempdir().unwrap();
        let journal = UpdateJournal::new(root.path().join("config"));
        (root, journal)
    }

    /// Stands in for `codesign`: counts every bundle it is asked to verify.
    struct CountingTrust(std::cell::Cell<usize>);

    impl flow::BundleTrust for CountingTrust {
        fn verify(&self, _bundle: &Path) -> Result<(), String> {
            self.0.set(self.0.get() + 1);
            Ok(())
        }
    }

    #[test]
    fn updater_on_non_mac_reports_unavailable_and_never_calls_codesign() {
        let codesign = CountingTrust(std::cell::Cell::new(0));
        for os in [PlatformOs::Windows, PlatformOs::Linux, PlatformOs::Unknown] {
            let outcome = when_updates_supported(os, || {
                flow::BundleTrust::verify(
                    &codesign,
                    Path::new("/Applications/Backplane Companion.app"),
                )
                .map_err(|message| UpdateError::Install { message })
            });
            assert_eq!(
                outcome,
                Err(UpdateError::UpdatesUnavailableOnPlatform),
                "{os:?}"
            );
        }
        assert_eq!(codesign.0.get(), 0);
    }

    #[test]
    fn updater_on_macos_runs_the_update_step() {
        let codesign = CountingTrust(std::cell::Cell::new(0));
        let outcome = when_updates_supported(PlatformOs::Macos, || {
            flow::BundleTrust::verify(
                &codesign,
                Path::new("/Applications/Backplane Companion.app"),
            )
            .map_err(|message| UpdateError::Install { message })
        });
        assert_eq!(outcome, Ok(()));
        assert_eq!(codesign.0.get(), 1);
    }

    #[test]
    fn updater_key_is_configured_only_by_a_non_blank_pubkey() {
        let configured = |value: serde_json::Value| updater_key_configured(Some(&value));
        assert!(!updater_key_configured(None));
        assert!(!configured(serde_json::json!({})));
        assert!(!configured(serde_json::json!({ "pubkey": "" })));
        assert!(!configured(serde_json::json!({ "pubkey": "  \n" })));
        assert!(!configured(serde_json::json!({ "pubkey": null })));
        assert!(configured(serde_json::json!({ "pubkey": "dW50cnVzdGVk" })));
    }

    #[test]
    fn shipped_config_carries_no_updater_key_until_the_key_is_rotated() {
        // RELEASE HOLD: no updater key is committed until the release key is
        // provisioned. A release needs that key here, and the change that adds it.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert!(!updater_key_configured(config.pointer("/plugins/updater")));
    }

    #[test]
    fn updates_without_a_key_never_run_the_step() {
        let codesign = CountingTrust(std::cell::Cell::new(0));
        let outcome = when_updates_allowed(PlatformOs::Macos, false, || {
            flow::BundleTrust::verify(
                &codesign,
                Path::new("/Applications/Backplane Companion.app"),
            )
            .map_err(|message| UpdateError::Install { message })
        });
        assert_eq!(outcome, Err(UpdateError::UpdatesNotConfigured));
        assert_eq!(codesign.0.get(), 0);
    }

    #[test]
    fn updates_with_a_key_run_only_where_the_platform_supports_them() {
        assert_eq!(
            when_updates_allowed(PlatformOs::Macos, true, || Ok(1)),
            Ok(1)
        );
        assert_eq!(
            when_updates_allowed(PlatformOs::Linux, true, || Ok(1)),
            Err(UpdateError::UpdatesUnavailableOnPlatform)
        );
        // The platform answer wins: off macOS there is nothing to configure.
        assert_eq!(
            when_updates_allowed(PlatformOs::Windows, false, || Ok(1)),
            Err(UpdateError::UpdatesUnavailableOnPlatform)
        );
    }

    #[test]
    fn updater_plugin_is_a_macos_only_dependency() {
        // D6: no updater off macOS, so its TLS stack (ring) stays out of the
        // Windows and Linux builds.
        let manifest = include_str!("../../Cargo.toml");
        let mut section = "";
        let mut sections_naming_the_updater = Vec::new();
        for line in manifest.lines() {
            if line.starts_with('[') {
                section = line;
            } else if line.starts_with("tauri-plugin-updater") {
                sections_naming_the_updater.push(section);
            }
        }
        assert_eq!(
            sections_naming_the_updater,
            [r#"[target.'cfg(target_os = "macos")'.dependencies]"#]
        );
    }

    #[test]
    fn updates_unavailable_serializes_with_its_kind() {
        assert_eq!(
            serde_json::to_value(UpdateError::UpdatesUnavailableOnPlatform).unwrap()["kind"],
            "updates_unavailable_on_platform"
        );
    }

    #[test]
    fn update_channel_endpoints_are_the_public_channel_manifests() {
        assert_eq!(
            UpdateChannel::Stable.endpoint().as_str(),
            "https://storage.googleapis.com/backplane-artifacts/companion-desktop/stable/latest.json"
        );
        assert_eq!(
            UpdateChannel::Beta.endpoint().as_str(),
            "https://storage.googleapis.com/backplane-artifacts/companion-desktop/beta/latest.json"
        );
    }

    #[test]
    fn update_channel_accepts_only_stable_and_beta() {
        assert_eq!(
            serde_json::from_str::<UpdateChannel>("\"beta\"").unwrap(),
            UpdateChannel::Beta
        );
        for refused in ["\"nightly\"", "\"Stable\"", "\"\"", "1", "null"] {
            assert!(
                serde_json::from_str::<UpdateChannel>(refused).is_err(),
                "{refused}"
            );
        }
    }

    #[test]
    fn channel_defaults_to_stable_without_settings() {
        let (_root, journal) = journal();
        assert_eq!(journal.channel(), UpdateChannel::Stable);
    }

    #[test]
    fn set_channel_persists_across_journals() {
        let (_root, journal) = journal();
        assert_eq!(
            journal.set_channel(UpdateChannel::Beta).unwrap(),
            UpdateChannel::Beta
        );
        let reopened = UpdateJournal::new(journal.directory());
        assert_eq!(reopened.channel(), UpdateChannel::Beta);
        journal.set_channel(UpdateChannel::Stable).unwrap();
        assert_eq!(reopened.channel(), UpdateChannel::Stable);
    }

    #[test]
    fn channel_falls_back_to_stable_on_an_unknown_or_corrupt_setting() {
        let (_root, journal) = journal();
        std::fs::create_dir_all(journal.directory()).unwrap();
        for contents in [r#"{"channel":"nightly"}"#, "not json", ""] {
            std::fs::write(journal.directory().join(SETTINGS_FILE), contents).unwrap();
            assert_eq!(journal.channel(), UpdateChannel::Stable, "{contents}");
        }
    }

    #[test]
    fn set_channel_reports_an_unwritable_config_dir() {
        let root = tempfile::tempdir().unwrap();
        let blocker = root.path().join("file");
        std::fs::write(&blocker, "").unwrap();
        let journal = UpdateJournal::new(blocker.join("config"));
        assert!(matches!(
            journal.set_channel(UpdateChannel::Beta),
            Err(UpdateError::Settings { .. })
        ));
    }

    fn pending() -> PendingUpdate {
        PendingUpdate {
            from_version: "0.1.0".into(),
            to_version: "0.2.0".into(),
            app_bundle: "/Applications/Backplane Companion.app".into(),
            previous_bundle: "/Applications/Backplane Companion.app.previous".into(),
            service_installed: true,
        }
    }

    #[test]
    fn pending_update_round_trips_and_clears() {
        let (_root, journal) = journal();
        assert_eq!(journal.pending(), None);
        journal.write_pending(&pending()).unwrap();
        assert_eq!(journal.pending(), Some(pending()));
        journal.clear_pending().unwrap();
        assert_eq!(journal.pending(), None);
        journal.clear_pending().unwrap();
    }

    #[test]
    fn failure_is_recorded_for_the_ui() {
        let (_root, journal) = journal();
        assert_eq!(journal.last_failure(), None);
        let failure = UpdateFailed {
            from_version: "0.1.0".into(),
            to_version: "0.2.0".into(),
            reason: UpdateFailureReason::Unhealthy,
            detail: "the daemon did not report 0.2.0 within 60 s".into(),
            failed_at_unix: 1,
        };
        journal.record_failure(&failure).unwrap();
        assert_eq!(journal.last_failure(), Some(failure));
    }

    #[test]
    fn update_failure_reasons_serialize_as_stable_codes() {
        for (reason, code) in [
            (
                UpdateFailureReason::AppVersionMismatch,
                "app_version_mismatch",
            ),
            (UpdateFailureReason::RefreshFailed, "refresh_failed"),
            (UpdateFailureReason::Unhealthy, "unhealthy"),
            (
                UpdateFailureReason::RollbackCopyUntrusted,
                "rollback_copy_untrusted",
            ),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), code);
        }
    }

    #[test]
    fn last_update_result_replaces_the_home_directory_with_a_tilde() {
        let (_root, journal) = journal();
        assert_eq!(journal.last_update_result(Path::new("/home/me")), None);
        journal
            .record_failure(&UpdateFailed {
                from_version: "0.1.0".into(),
                to_version: "0.2.0".into(),
                reason: UpdateFailureReason::RefreshFailed,
                detail: "service install: /home/me/Library/LaunchAgents/x.plist; /home/meow stays"
                    .into(),
                failed_at_unix: 7,
            })
            .unwrap();
        let shown = journal.last_update_result(Path::new("/home/me")).unwrap();
        assert_eq!(
            shown.detail,
            "service install: ~/Library/LaunchAgents/x.plist; /home/meow stays"
        );
        assert_eq!(shown.reason, UpdateFailureReason::RefreshFailed);
        assert_eq!(shown.failed_at_unix, 7);
    }

    #[test]
    fn highest_offered_is_kept_per_channel_and_never_lowered() {
        let (_root, journal) = journal();
        assert_eq!(journal.highest_offered(UpdateChannel::Stable), None);
        journal
            .record_offered(UpdateChannel::Beta, "0.3.0-beta.1")
            .unwrap();
        journal
            .record_offered(UpdateChannel::Beta, "0.2.0")
            .unwrap();
        journal
            .record_offered(UpdateChannel::Stable, "0.2.5")
            .unwrap();
        journal
            .record_offered(UpdateChannel::Stable, "garbage")
            .unwrap();
        let reopened = UpdateJournal::new(journal.directory());
        assert_eq!(
            reopened.highest_offered(UpdateChannel::Beta).as_deref(),
            Some("0.3.0-beta.1")
        );
        assert_eq!(
            reopened.highest_offered(UpdateChannel::Stable).as_deref(),
            Some("0.2.5")
        );
    }

    #[test]
    fn offer_is_acceptable_only_above_the_running_and_the_highest_seen_version() {
        assert!(offer_is_acceptable("0.1.0", "0.2.0", None));
        assert!(offer_is_acceptable("0.1.0", "0.2.0", Some("0.2.0")));
        assert!(!offer_is_acceptable("0.2.0", "0.2.0", None));
        assert!(!offer_is_acceptable("0.2.0", "0.1.9", None));
        // A stale (frozen or replayed) manifest: newer than what runs, but
        // older than a release this channel already announced.
        assert!(!offer_is_acceptable("0.1.0", "0.2.0", Some("0.3.0")));
        assert!(!offer_is_acceptable("0.1.0", "not-a-version", None));
    }

    #[test]
    fn previous_bundle_is_a_sibling_of_the_app() {
        assert_eq!(
            previous_bundle_of(Path::new("/Applications/Backplane Companion.app")),
            PathBuf::from("/Applications/Backplane Companion.app.previous")
        );
    }
}
