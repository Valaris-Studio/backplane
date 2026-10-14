// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The notifications on/off preference, persisted in the app config dir. The
//! engine reads the shared flag, so a toggle applies to the very next event.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::daemon::DaemonError;

pub const NOTIFICATIONS_FILE: &str = "notifications.json";

pub struct NotificationPreference {
    file: Option<PathBuf>,
    enabled: Arc<AtomicBool>,
}

#[derive(Serialize, Deserialize)]
struct StoredPreference {
    enabled: bool,
}

impl NotificationPreference {
    /// On by default; a missing or unreadable file is the default, not an error.
    pub fn load(config_dir: Option<PathBuf>) -> Self {
        let file = config_dir.map(|dir| dir.join(NOTIFICATIONS_FILE));
        let enabled = file
            .as_ref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|raw| serde_json::from_slice::<StoredPreference>(&raw).ok())
            .is_none_or(|stored| stored.enabled);
        Self {
            file,
            enabled: Arc::new(AtomicBool::new(enabled)),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn flag(&self) -> Arc<AtomicBool> {
        self.enabled.clone()
    }

    /// Persists first: the in-memory flag changes only once the file says so.
    pub fn set(&self, enabled: bool) -> Result<bool, DaemonError> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| DaemonError::local("the app config folder is unknown"))?;
        let write = || -> std::io::Result<()> {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let staged = file.with_extension("json.tmp");
            std::fs::write(&staged, serde_json::to_vec(&StoredPreference { enabled })?)?;
            std::fs::rename(&staged, file)
        };
        write().map_err(|error| {
            DaemonError::local(format!("the preference could not be saved: {error}"))
        })?;
        self.enabled.store(enabled, Ordering::SeqCst);
        Ok(enabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_defaults_to_on_when_nothing_was_saved() {
        let config = tempfile::tempdir().unwrap();
        let preference = NotificationPreference::load(Some(config.path().join("missing")));
        assert!(preference.enabled());
        assert!(preference.flag().load(Ordering::SeqCst));
    }

    #[test]
    fn set_persists_across_loads_and_updates_the_shared_flag() {
        let config = tempfile::tempdir().unwrap();
        let dir = config.path().join("not-yet-created");
        let preference = NotificationPreference::load(Some(dir.clone()));
        let flag = preference.flag();
        assert_eq!(preference.set(false), Ok(false));
        assert!(!flag.load(Ordering::SeqCst));
        assert!(!NotificationPreference::load(Some(dir.clone())).enabled());
        assert_eq!(preference.set(true), Ok(true));
        assert!(NotificationPreference::load(Some(dir)).enabled());
    }

    #[test]
    fn load_treats_an_unreadable_file_as_the_default() {
        let config = tempfile::tempdir().unwrap();
        std::fs::write(config.path().join(NOTIFICATIONS_FILE), "not json").unwrap();
        assert!(NotificationPreference::load(Some(config.path().to_path_buf())).enabled());
    }

    #[test]
    fn set_without_a_config_dir_fails_and_keeps_the_current_value() {
        let preference = NotificationPreference::load(None);
        assert!(matches!(
            preference.set(false),
            Err(DaemonError::Local { .. })
        ));
        assert!(preference.enabled());
    }

    #[cfg(unix)]
    #[test]
    fn set_that_cannot_write_keeps_the_current_value() {
        use std::os::unix::fs::PermissionsExt;
        let config = tempfile::tempdir().unwrap();
        let locked = config.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let preference = NotificationPreference::load(Some(locked.clone()));
        assert!(matches!(
            preference.set(false),
            Err(DaemonError::Local { .. })
        ));
        assert!(preference.enabled());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
}
