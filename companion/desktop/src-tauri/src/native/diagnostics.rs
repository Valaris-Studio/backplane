// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! "Save diagnostics…": the daemon builds the scrubbed zip, Rust asks where to
//! put it and writes it. Only the chosen file name goes back to the webview.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use specta::Type;

use super::dialogs::NativeDialogs;
use crate::daemon::{DaemonClient, DaemonError};

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct SavedDiagnostics {
    pub saved: bool,
    pub file_name: Option<String>,
}

const SECONDS_PER_DAY: u64 = 86_400;

/// `backplane-diagnostics-YYYY-MM-DD.zip`, dated in UTC.
pub fn default_file_name(now: SystemTime) -> String {
    let days = now
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() / SECONDS_PER_DAY)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(days as i64);
    format!("backplane-diagnostics-{year:04}-{month:02}-{day:02}.zip")
}

/// Howard Hinnant's days-to-civil algorithm (proleptic Gregorian calendar).
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Fetches before asking where to save, so a daemon that is down or refuses
/// never leaves the user with a dialog that can only fail.
pub async fn save_diagnostics(
    client: &DaemonClient,
    dialogs: &dyn NativeDialogs,
    downloads: Option<&Path>,
    now: SystemTime,
) -> Result<SavedDiagnostics, DaemonError> {
    let archive = client.diagnostics().await?;
    let chosen = dialogs
        .choose_save_path(downloads, &default_file_name(now))
        .await
        .ok()
        .flatten();
    let Some(target) = chosen else {
        return Ok(SavedDiagnostics {
            saved: false,
            file_name: None,
        });
    };
    write_atomically(&target, &archive).map_err(|error| {
        DaemonError::local(format!("the diagnostics could not be saved: {error}"))
    })?;
    Ok(SavedDiagnostics {
        saved: true,
        file_name: file_name_of(&target),
    })
}

/// Stages the archive next to `target`, then renames it into place, so a
/// failed save never leaves a half-written file. The staging file is created
/// exclusively (it can never be a pre-planted link), and the rename replaces
/// a symlink at `target`, never the file it points to.
pub(crate) fn write_atomically(target: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    let staged = dir.join(format!(
        ".{}.{}-{nanos}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));
    let written = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        file.write_all(contents)?;
        file.sync_all()?;
        // rename(2) replaces a symlink at `target` itself, never its target.
        std::fs::rename(&staged, target)?;
        sync_dir(dir)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    written
}

/// Makes the rename durable. Windows cannot open a directory as a file; its
/// rename is already journaled.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

fn file_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn default_file_name_uses_the_utc_date() {
        let day = |seconds: u64| default_file_name(UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(day(0), "backplane-diagnostics-1970-01-01.zip");
        // 2026-09-28T23:59:59Z
        assert_eq!(day(1_790_639_999), "backplane-diagnostics-2026-09-28.zip");
        // 2024-02-29T12:00:00Z, a leap day
        assert_eq!(day(1_709_208_000), "backplane-diagnostics-2024-02-29.zip");
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn write_atomically_creates_the_file_and_leaves_no_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("diagnostics.zip");
        write_atomically(&target, b"zip").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"zip");
        assert_eq!(entries(dir.path()), vec!["diagnostics.zip".to_string()]);
    }

    #[test]
    fn write_atomically_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("diagnostics.zip");
        std::fs::write(&target, b"an older and longer archive").unwrap();
        write_atomically(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        assert_eq!(entries(dir.path()), vec!["diagnostics.zip".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn write_atomically_replaces_a_symlink_instead_of_writing_through_it() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim");
        std::fs::write(&victim, b"precious").unwrap();
        let target = dir.path().join("diagnostics.zip");
        std::os::unix::fs::symlink(&victim, &target).unwrap();
        write_atomically(&target, b"zip").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        assert!(!std::fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"zip");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomically_never_creates_a_dangling_symlinks_destination() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        let target = dir.path().join("diagnostics.zip");
        std::os::unix::fs::symlink(&elsewhere, &target).unwrap();
        write_atomically(&target, b"zip").unwrap();
        assert!(!elsewhere.exists());
        assert!(!std::fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"zip");
    }

    #[cfg(unix)]
    #[test]
    fn write_atomically_that_cannot_write_leaves_the_old_file_and_no_staging_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("diagnostics.zip");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = write_atomically(&target, b"new");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert_eq!(entries(dir.path()), vec!["diagnostics.zip".to_string()]);
    }
}
