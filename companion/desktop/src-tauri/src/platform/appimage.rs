// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! An AppImage runs from a FUSE mount that vanishes when the app quits, so the
//! systemd unit and the agents' hooks cannot point at the companion inside it.
//! On enable, the companion is copied into a private per-user directory, and
//! only a copy whose sha256 matches the manifest shipped beside it is used.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::capture::COMPANION_BINARY;

/// `sha256sum` output for the companion, packaged beside it in the AppImage.
pub const COMPANION_MANIFEST: &str = "backplane-companion.sha256";
const STAGING_UNDER_HOME: &[&str] = &[".local", "lib", "backplane-companion"];
/// An AppImage runs from a FUSE mount (`$TMPDIR/.mount_XXXX`) that is gone
/// once the app quits.
pub(crate) const APPIMAGE_MOUNT_PREFIX: &str = ".mount_";
const MAX_MANIFEST_BYTES: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StagingError {
    #[error("the companion's sha256 manifest is missing or unreadable ({path})")]
    ManifestMissing { path: PathBuf },
    #[error("the bundled companion does not match its sha256 manifest ({path})")]
    HashMismatch { path: PathBuf },
    #[error("the staging folder is a symlink ({path})")]
    SymlinkedTarget { path: PathBuf },
    #[error("the staging folder is not a folder this user owns ({path})")]
    ForeignTarget { path: PathBuf },
    #[error("the companion could not be staged into {path}: {message}")]
    Io { path: PathBuf, message: String },
}

impl StagingError {
    pub fn path(&self) -> &Path {
        match self {
            Self::ManifestMissing { path }
            | Self::HashMismatch { path }
            | Self::SymlinkedTarget { path }
            | Self::ForeignTarget { path }
            | Self::Io { path, .. } => path,
        }
    }
}

/// Where an AppImage run stages its companion, or None when this is not an
/// AppImage launch with a usable home (then nothing is staged or trusted).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppImageStaging {
    /// The `.AppImage` file itself, which is what the user installed.
    pub appimage: PathBuf,
    /// Where the checks start: the home folder itself may be a link (as on
    /// systems that mount /home elsewhere), anything under it may not.
    pub home: PathBuf,
    pub target_dir: PathBuf,
}

impl AppImageStaging {
    pub fn from_environment(getenv: impl Fn(&str) -> Option<OsString>) -> Option<Self> {
        let appimage = PathBuf::from(getenv("APPIMAGE")?);
        let home = PathBuf::from(getenv("HOME")?);
        let usable = |path: &Path| {
            path.is_absolute()
                && path.parent().is_some()
                && !path
                    .components()
                    .any(|part| part == Component::ParentDir || is_mount_component(part))
        };
        if !usable(&appimage) || !usable(&home) {
            return None;
        }
        let target_dir = staging_dir(&home);
        Some(Self {
            appimage,
            home,
            target_dir,
        })
    }

    pub fn staged_companion(&self) -> PathBuf {
        self.target_dir.join(COMPANION_BINARY)
    }

    /// Copies `source` (the companion inside the mount) into the target
    /// directory, idempotently, and returns the staged path.
    pub fn stage(&self, source: &Path) -> Result<PathBuf, StagingError> {
        let expected = read_manifest(&source.with_file_name(COMPANION_MANIFEST))?;
        let bytes = std::fs::read(source).map_err(|error| io_error(source, error))?;
        if sha256_hex(&bytes) != expected {
            return Err(StagingError::HashMismatch {
                path: source.to_path_buf(),
            });
        }
        prepare_private_dir(&self.home, &self.target_dir)?;
        let staged = self.staged_companion();
        let already_staged = std::fs::symlink_metadata(&staged)
            .is_ok_and(|metadata| metadata.file_type().is_file())
            && std::fs::read(&staged).is_ok_and(|current| sha256_hex(&current) == expected);
        if !already_staged {
            write_private_executable(&self.target_dir, &staged, &bytes)?;
        }
        // Re-read what the unit and hooks will run, not what was meant to be written.
        let written = std::fs::read(&staged).map_err(|error| io_error(&staged, error))?;
        if sha256_hex(&written) != expected {
            return Err(StagingError::HashMismatch { path: staged });
        }
        Ok(staged)
    }
}

pub fn staging_dir(home: &Path) -> PathBuf {
    STAGING_UNDER_HOME
        .iter()
        .fold(home.to_path_buf(), |path, segment| path.join(segment))
}

pub(crate) fn is_mount_component(part: Component<'_>) -> bool {
    matches!(part, Component::Normal(name)
        if name.to_string_lossy().starts_with(APPIMAGE_MOUNT_PREFIX))
}

fn io_error(path: &Path, error: std::io::Error) -> StagingError {
    StagingError::Io {
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The first field of `sha256sum` output: 64 hex digits.
fn read_manifest(manifest: &Path) -> Result<String, StagingError> {
    let missing = || StagingError::ManifestMissing {
        path: manifest.to_path_buf(),
    };
    let mut raw = String::new();
    std::fs::File::open(manifest)
        .and_then(|file| file.take(MAX_MANIFEST_BYTES).read_to_string(&mut raw))
        .map_err(|_| missing())?;
    let hash = raw.split_whitespace().next().ok_or_else(missing)?;
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(hash.to_ascii_lowercase())
    } else {
        Err(missing())
    }
}

/// Every folder from the home down to the staging folder must be a real
/// directory owned by this user, and the last one closed to everyone else: the
/// systemd unit runs whatever sits in it at every login. Each level is created
/// on its own and checked without following links, so a planted `~/.local`
/// or `~/.local/lib` link cannot redirect the copy.
#[cfg(unix)]
fn prepare_private_dir(home: &Path, target_dir: &Path) -> Result<(), StagingError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};

    let foreign = |path: &Path| StagingError::ForeignTarget {
        path: path.to_path_buf(),
    };
    let below_home = target_dir
        .strip_prefix(home)
        .map_err(|_| foreign(target_dir))?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let own_uid = unsafe { libc::geteuid() };
    let mut level = home.to_path_buf();
    for segment in below_home.components() {
        level.push(segment);
        let mode = if level == target_dir { 0o700 } else { 0o755 };
        match std::fs::DirBuilder::new().mode(mode).create(&level) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(io_error(&level, error)),
        }
        let metadata =
            std::fs::symlink_metadata(&level).map_err(|error| io_error(&level, error))?;
        if metadata.file_type().is_symlink() {
            return Err(StagingError::SymlinkedTarget { path: level });
        }
        if !metadata.is_dir() || metadata.uid() != own_uid {
            return Err(foreign(&level));
        }
    }
    let mode = std::fs::symlink_metadata(target_dir)
        .map_err(|error| io_error(target_dir, error))?
        .permissions()
        .mode();
    if mode & 0o777 != 0o700 {
        std::fs::set_permissions(target_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| io_error(target_dir, error))?;
    }
    Ok(())
}

/// Written beside the target and renamed over it, so a unit starting mid-copy
/// never runs half a binary.
#[cfg(unix)]
fn write_private_executable(dir: &Path, staged: &Path, bytes: &[u8]) -> Result<(), StagingError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let partial = dir.join(format!(
        ".{COMPANION_BINARY}.staging-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&partial);
    let write = || -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&partial, staged)?;
        std::fs::File::open(dir)?.sync_all()
    };
    write().map_err(|error| {
        let _ = std::fs::remove_file(&partial);
        io_error(staged, error)
    })
}

#[cfg(not(unix))]
fn prepare_private_dir(_home: &Path, target_dir: &Path) -> Result<(), StagingError> {
    Err(StagingError::ForeignTarget {
        path: target_dir.to_path_buf(),
    })
}

#[cfg(not(unix))]
fn write_private_executable(_dir: &Path, staged: &Path, _bytes: &[u8]) -> Result<(), StagingError> {
    Err(StagingError::ForeignTarget {
        path: staged.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    // Staging needs Unix permissions; its tests and helpers are Unix-only.
    #[cfg(unix)]
    const COMPANION_BYTES: &[u8] = b"#!/bin/sh\necho companion\n";
    #[cfg(unix)]
    /// Well-formed, but the hash of something else.
    const OTHER_SHA256: &str = "b3d0b7d67e40dc0cd9ac0bdc9a6d9d3b5d0fe8ec9a4d91a5b9bd3b92c7c8d5f7";

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let variables: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect();
        move |name| variables.get(name).cloned()
    }

    #[cfg(unix)]
    fn real_sha256(bytes: &[u8]) -> String {
        use sha2::Digest;
        sha2::Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[cfg(unix)]
    /// A fake AppImage mount holding the companion and its manifest.
    fn mount_with(bytes: &[u8], manifest: Option<&str>) -> (tempfile::TempDir, PathBuf) {
        let mount = tempfile::tempdir().unwrap();
        let bin = mount.path().join("usr").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(COMPANION_BINARY), bytes).unwrap();
        if let Some(manifest) = manifest {
            std::fs::write(bin.join(COMPANION_MANIFEST), manifest).unwrap();
        }
        let source = bin.join(COMPANION_BINARY);
        (mount, source)
    }

    #[cfg(unix)]
    fn staging_in(home: &Path) -> AppImageStaging {
        AppImageStaging {
            appimage: home.join("Downloads/Backplane_Companion.AppImage"),
            home: home.to_path_buf(),
            target_dir: home.join(".local/lib/backplane-companion"),
        }
    }

    #[test]
    fn staging_needs_an_absolute_appimage_and_home() {
        let staging = AppImageStaging::from_environment(environment(&[
            ("APPIMAGE", "/home/me/Apps/Backplane Companion.AppImage"),
            ("HOME", "/home/me"),
        ]))
        .unwrap();
        assert_eq!(
            staging.appimage,
            Path::new("/home/me/Apps/Backplane Companion.AppImage")
        );
        assert_eq!(
            staging.target_dir,
            Path::new("/home/me/.local/lib/backplane-companion")
        );
        assert_eq!(
            staging.staged_companion(),
            Path::new("/home/me/.local/lib/backplane-companion/backplane-companion")
        );
    }

    #[test]
    fn staging_is_off_without_a_usable_appimage_or_home() {
        for pairs in [
            vec![("HOME", "/home/me")],
            vec![("APPIMAGE", "/home/me/a.AppImage")],
            vec![("APPIMAGE", "a.AppImage"), ("HOME", "/home/me")],
            vec![("APPIMAGE", "/home/me/a.AppImage"), ("HOME", "home/me")],
            vec![("APPIMAGE", ""), ("HOME", "/home/me")],
            vec![
                ("APPIMAGE", "/home/me/../tmp/a.AppImage"),
                ("HOME", "/home/me"),
            ],
            vec![
                ("APPIMAGE", "/tmp/.mount_abc/a.AppImage"),
                ("HOME", "/home/me"),
            ],
            vec![("APPIMAGE", "/home/me/a.AppImage"), ("HOME", "/")],
        ] {
            assert_eq!(
                AppImageStaging::from_environment(environment(&pairs)),
                None,
                "{pairs:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn appimage_enable_stages_companion_into_local_lib() {
        let home = tempfile::tempdir().unwrap();
        let (_mount, source) = mount_with(
            COMPANION_BYTES,
            Some(&format!(
                "{}  backplane-companion\n",
                real_sha256(COMPANION_BYTES)
            )),
        );
        let staging = staging_in(home.path());

        let staged = staging.stage(&source).unwrap();

        assert_eq!(staged, staging.staged_companion());
        assert_eq!(std::fs::read(&staged).unwrap(), COMPANION_BYTES);
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&staging.target_dir), 0o700);
        assert_eq!(mode(&staged), 0o700);
        // Idempotent: a second enable keeps the verified copy.
        assert_eq!(staging.stage(&source).unwrap(), staged);
        let leftovers: Vec<_> = std::fs::read_dir(&staging.target_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, [OsString::from(COMPANION_BINARY)]);
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_replaces_a_stale_copy_and_tightens_the_folder() {
        let home = tempfile::tempdir().unwrap();
        let staging = staging_in(home.path());
        std::fs::create_dir_all(&staging.target_dir).unwrap();
        std::fs::set_permissions(&staging.target_dir, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::write(staging.staged_companion(), b"an older companion").unwrap();
        let (_mount, source) = mount_with(COMPANION_BYTES, Some(&real_sha256(COMPANION_BYTES)));

        let staged = staging.stage(&source).unwrap();

        assert_eq!(std::fs::read(&staged).unwrap(), COMPANION_BYTES);
        let mode = std::fs::metadata(&staging.target_dir)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_refuses_symlinked_target_dir() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let staging = staging_in(home.path());
        std::fs::create_dir_all(staging.target_dir.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &staging.target_dir).unwrap();
        let (_mount, source) = mount_with(COMPANION_BYTES, Some(&real_sha256(COMPANION_BYTES)));

        assert_eq!(
            staging.stage(&source),
            Err(StagingError::SymlinkedTarget {
                path: staging.target_dir.clone()
            })
        );
        assert_eq!(std::fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }

    /// `create_dir_all` would follow a planted link and create the staging
    /// folder wherever it points.
    #[cfg(unix)]
    fn assert_refuses_symlinked_parent(linked: &str) {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let staging = staging_in(home.path());
        let link = home.path().join(linked);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), &link).unwrap();
        let (_mount, source) = mount_with(COMPANION_BYTES, Some(&real_sha256(COMPANION_BYTES)));

        assert_eq!(
            staging.stage(&source),
            Err(StagingError::SymlinkedTarget { path: link }),
            "{linked}"
        );
        assert_eq!(
            std::fs::read_dir(elsewhere.path()).unwrap().count(),
            0,
            "{linked}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_refuses_a_symlinked_local_lib() {
        assert_refuses_symlinked_parent(".local/lib");
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_refuses_a_symlinked_local() {
        assert_refuses_symlinked_parent(".local");
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_creates_missing_parents_under_home() {
        let home = tempfile::tempdir().unwrap();
        let (_mount, source) = mount_with(COMPANION_BYTES, Some(&real_sha256(COMPANION_BYTES)));
        let staging = staging_in(home.path());
        assert!(!home.path().join(".local").exists());
        assert_eq!(staging.stage(&source).unwrap(), staging.staged_companion());
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_refuses_a_target_that_is_a_file() {
        let home = tempfile::tempdir().unwrap();
        let staging = staging_in(home.path());
        std::fs::create_dir_all(staging.target_dir.parent().unwrap()).unwrap();
        std::fs::write(&staging.target_dir, b"not a folder").unwrap();
        let (_mount, source) = mount_with(COMPANION_BYTES, Some(&real_sha256(COMPANION_BYTES)));

        assert!(matches!(
            staging.stage(&source),
            Err(StagingError::ForeignTarget { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_refuses_hash_mismatch() {
        let home = tempfile::tempdir().unwrap();
        let (_mount, source) = mount_with(COMPANION_BYTES, Some(OTHER_SHA256));
        let staging = staging_in(home.path());

        assert!(matches!(
            staging.stage(&source),
            Err(StagingError::HashMismatch { .. })
        ));
        assert!(!staging.staged_companion().exists());
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_keeps_nothing_from_a_mismatched_copy_already_there() {
        let home = tempfile::tempdir().unwrap();
        let staging = staging_in(home.path());
        std::fs::create_dir_all(&staging.target_dir).unwrap();
        std::fs::write(staging.staged_companion(), COMPANION_BYTES).unwrap();
        // The mount's companion was swapped: its manifest no longer matches it.
        let (_mount, source) = mount_with(b"tampered", Some(&real_sha256(COMPANION_BYTES)));

        assert!(matches!(
            staging.stage(&source),
            Err(StagingError::HashMismatch { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_refuses_a_missing_or_malformed_manifest() {
        for manifest in [
            None,
            Some(""),
            Some("not-a-hash  backplane-companion"),
            Some("abc"),
        ] {
            let home = tempfile::tempdir().unwrap();
            let (_mount, source) = mount_with(COMPANION_BYTES, manifest);
            let staging = staging_in(home.path());
            assert!(
                matches!(
                    staging.stage(&source),
                    Err(StagingError::ManifestMissing { .. })
                ),
                "{manifest:?}"
            );
            assert!(!staging.target_dir.exists(), "{manifest:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn appimage_staging_accepts_an_upper_case_manifest() {
        let home = tempfile::tempdir().unwrap();
        let (_mount, source) = mount_with(
            COMPANION_BYTES,
            Some(&real_sha256(COMPANION_BYTES).to_uppercase()),
        );
        assert!(staging_in(home.path()).stage(&source).is_ok());
    }
}
