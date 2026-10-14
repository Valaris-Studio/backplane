// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Where the app must be installed before it may run its bundled companion.
//! Capture registers that companion as a login service and as every agent's
//! hook, so a copy in a user-writable or temporary place could be swapped or
//! vanish under them.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use super::appimage::{is_mount_component, AppImageStaging, StagingError};
use super::PlatformOs;
use crate::capture::{AppLocation, CaptureError, COMPANION_BINARY};

const MACOS_APPLICATIONS: &str = "/Applications";
/// A DMG mount or a Gatekeeper App Translocation copy vanishes after eject or
/// relaunch; a LaunchAgent or hook pointing there would break silently.
const MACOS_EPHEMERAL_PREFIXES: &[&str] = &["/Volumes/"];
const MACOS_TRANSLOCATION_MARKER: &str = "/AppTranslocation/";
/// Root-owned, where the deb and rpm packages install.
const LINUX_INSTALL_ROOT: &str = "/usr/lib/backplane-companion";
/// The per-user NSIS install: `%LOCALAPPDATA%\Programs\Backplane Companion`.
const WINDOWS_INSTALL_UNDER_LOCAL_APP_DATA: &[&str] = &["Programs", "Backplane Companion"];
const WINDOWS_COMPANION_BINARY: &str = "backplane-companion.exe";
/// What `std::fs::canonicalize` puts in front of a local Windows path.
const WINDOWS_VERBATIM_PREFIX: &str = r"\\?\";

pub trait InstallPolicy: Send + Sync {
    /// Where the app runs from, so the UI can ask for a proper install.
    fn app_location(&self, executable: &Path) -> AppLocation;

    /// A location that disappears (a mounted image), as opposed to one that
    /// is merely untrusted.
    fn is_ephemeral(&self, executable: &Path) -> bool;

    /// The companion beside an app installed in the trusted root; whether the
    /// file exists is not checked.
    fn companion_beside_trusted_app(&self, executable: &Path) -> Result<PathBuf, CaptureError>;

    fn trusted_companion(&self, executable: &Path) -> Result<PathBuf, CaptureError> {
        if self.is_ephemeral(executable) {
            return Err(CaptureError::EphemeralLocation {
                path: self.app_location(executable).path,
            });
        }
        require_file(self.companion_beside_trusted_app(executable)?)
    }
}

pub fn require_file(companion: PathBuf) -> Result<PathBuf, CaptureError> {
    if companion.is_file() {
        Ok(companion)
    } else {
        Err(CaptureError::NotBundled {
            path: companion.to_string_lossy().into_owned(),
        })
    }
}

pub fn install_policy_for(
    os: PlatformOs,
    getenv: impl Fn(&str) -> Option<OsString>,
) -> Box<dyn InstallPolicy> {
    match os {
        PlatformOs::Macos => Box::new(MacosInstall::under(MACOS_APPLICATIONS)),
        PlatformOs::Linux => Box::new(LinuxInstall {
            root: PathBuf::from(LINUX_INSTALL_ROOT),
            appimage: AppImageStaging::from_environment(&getenv),
        }),
        PlatformOs::Windows => Box::new(WindowsInstall::from_local_app_data(
            getenv("LOCALAPPDATA").as_deref(),
        )),
        PlatformOs::Unknown => Box::new(TrustNothing),
    }
}

pub fn current_install_policy() -> Box<dyn InstallPolicy> {
    install_policy_for(PlatformOs::current(), |name| std::env::var_os(name))
}

fn not_in_applications(location: &Path) -> CaptureError {
    CaptureError::NotInApplications {
        path: location.to_string_lossy().into_owned(),
    }
}

fn has_parent_dir_segment(path: &Path) -> bool {
    path.components().any(|part| part == Component::ParentDir)
}

/// The .app bundle an executable in `X.app/Contents/MacOS/` belongs to.
pub fn app_bundle_of(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle
        .extension()
        .is_some_and(|extension| extension == "app");
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && is_app)
        .then_some(bundle)
}

/// The bundle must sit directly in the system Applications folder:
/// user-writable places like ~/Applications or Downloads could have it
/// swapped under a LaunchAgent that runs at every login.
pub struct MacosInstall {
    applications: PathBuf,
}

impl MacosInstall {
    pub fn under(applications: impl Into<PathBuf>) -> Self {
        Self {
            applications: applications.into(),
        }
    }
}

impl InstallPolicy for MacosInstall {
    fn app_location(&self, executable: &Path) -> AppLocation {
        let bundle = app_bundle_of(executable);
        AppLocation {
            in_applications: bundle.is_some_and(|bundle| bundle.starts_with(&self.applications)),
            path: bundle.unwrap_or(executable).to_string_lossy().into_owned(),
        }
    }

    fn is_ephemeral(&self, executable: &Path) -> bool {
        let location = app_bundle_of(executable).unwrap_or(executable);
        let location = location.to_string_lossy();
        MACOS_EPHEMERAL_PREFIXES
            .iter()
            .any(|prefix| location.starts_with(prefix))
            || location.contains(MACOS_TRANSLOCATION_MARKER)
    }

    fn companion_beside_trusted_app(&self, executable: &Path) -> Result<PathBuf, CaptureError> {
        let bundle = app_bundle_of(executable);
        let inside = bundle.is_some_and(|bundle| {
            bundle.parent() == Some(self.applications.as_path()) && !has_parent_dir_segment(bundle)
        });
        if inside {
            Ok(executable.with_file_name(COMPANION_BINARY))
        } else {
            Err(not_in_applications(bundle.unwrap_or(executable)))
        }
    }
}

/// The GUI binary lives directly in the package's root-owned directory; a
/// `/usr/bin` symlink resolves there because the executable is canonical.
/// An AppImage run is trusted through its staged companion instead: the mount
/// is read-only while it runs, and staging copies only a hash-verified binary.
pub struct LinuxInstall {
    root: PathBuf,
    appimage: Option<AppImageStaging>,
}

impl LinuxInstall {
    fn appimage_run(&self, executable: &Path) -> Option<&AppImageStaging> {
        self.appimage
            .as_ref()
            .filter(|_| self.is_ephemeral(executable) && !has_parent_dir_segment(executable))
    }
}

impl InstallPolicy for LinuxInstall {
    fn app_location(&self, executable: &Path) -> AppLocation {
        if let Some(staging) = self.appimage_run(executable) {
            return AppLocation {
                in_applications: true,
                path: staging.appimage.to_string_lossy().into_owned(),
            };
        }
        AppLocation {
            in_applications: !self.is_ephemeral(executable)
                && self.companion_beside_trusted_app(executable).is_ok(),
            path: executable.to_string_lossy().into_owned(),
        }
    }

    fn is_ephemeral(&self, executable: &Path) -> bool {
        executable.components().any(is_mount_component)
    }

    /// For an AppImage run this is the staged copy, which is what the
    /// service and hooks were pointed at.
    fn companion_beside_trusted_app(&self, executable: &Path) -> Result<PathBuf, CaptureError> {
        if let Some(staging) = self.appimage_run(executable) {
            return Ok(staging.staged_companion());
        }
        if executable.parent() == Some(self.root.as_path()) && !has_parent_dir_segment(executable) {
            Ok(executable.with_file_name(COMPANION_BINARY))
        } else {
            Err(not_in_applications(executable))
        }
    }

    fn trusted_companion(&self, executable: &Path) -> Result<PathBuf, CaptureError> {
        let Some(staging) = self.appimage_run(executable) else {
            if self.is_ephemeral(executable) {
                return Err(CaptureError::EphemeralLocation {
                    path: executable.to_string_lossy().into_owned(),
                });
            }
            return require_file(self.companion_beside_trusted_app(executable)?);
        };
        staging
            .stage(&executable.with_file_name(COMPANION_BINARY))
            .map_err(|error| {
                log::warn!("the AppImage companion was not staged: {error}");
                staging_failure(error)
            })
    }
}

/// Reported with the existing kinds so the webview's copy stays unchanged: a
/// companion that fails its manifest reads as an incomplete app ("reinstall").
fn staging_failure(error: StagingError) -> CaptureError {
    CaptureError::NotBundled {
        path: error.path().to_string_lossy().into_owned(),
    }
}

/// Windows paths are parsed as text, not with `Path`, so the rules hold (and
/// are tested) the same on every host.
pub struct WindowsInstall {
    /// Lower-cased segments of the install directory, drive first; None when
    /// LOCALAPPDATA is missing or not an absolute local path.
    install_dir: Option<Vec<String>>,
}

impl WindowsInstall {
    fn from_local_app_data(local_app_data: Option<&std::ffi::OsStr>) -> Self {
        let local_app_data = local_app_data.map(|value| value.to_string_lossy());
        let install_dir = local_app_data
            .as_deref()
            .and_then(windows_segments)
            .map(|segments| {
                segments
                    .into_iter()
                    .chain(WINDOWS_INSTALL_UNDER_LOCAL_APP_DATA.iter().copied())
                    .map(str::to_lowercase)
                    .collect()
            });
        Self { install_dir }
    }

    fn is_installed(&self, executable: &str) -> bool {
        let (Some(install_dir), Some(segments)) = (&self.install_dir, windows_segments(executable))
        else {
            return false;
        };
        let Some((_, directory)) = segments.split_last() else {
            return false;
        };
        // Windows compares path names case-insensitively.
        directory.len() == install_dir.len()
            && directory
                .iter()
                .zip(install_dir)
                .all(|(segment, expected)| segment.to_lowercase() == *expected)
    }
}

/// The segments of an absolute local path (`C:\…`, also in its `\\?\C:\…`
/// verbatim form). None for UNC shares, drive-relative or relative paths and
/// any `.`, `..` or empty segment.
pub(crate) fn windows_segments(path: &str) -> Option<Vec<&str>> {
    let path = path.strip_prefix(WINDOWS_VERBATIM_PREFIX).unwrap_or(path);
    let segments: Vec<&str> = path.split(['\\', '/']).collect();
    let drive = segments.first()?.as_bytes();
    let is_drive = drive.len() == 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':';
    let well_formed = segments.len() > 1
        && segments[1..]
            .iter()
            .all(|segment| !matches!(*segment, "" | "." | ".."));
    (is_drive && well_formed).then_some(segments)
}

impl InstallPolicy for WindowsInstall {
    fn app_location(&self, executable: &Path) -> AppLocation {
        let path = executable.to_string_lossy().into_owned();
        AppLocation {
            in_applications: self.is_installed(&path),
            path,
        }
    }

    fn is_ephemeral(&self, _executable: &Path) -> bool {
        false
    }

    fn companion_beside_trusted_app(&self, executable: &Path) -> Result<PathBuf, CaptureError> {
        let path = executable.to_string_lossy();
        if !self.is_installed(&path) {
            return Err(not_in_applications(executable));
        }
        let directory_end = path
            .rfind(['\\', '/'])
            .ok_or_else(|| not_in_applications(executable))?;
        Ok(PathBuf::from(format!(
            "{}\\{WINDOWS_COMPANION_BINARY}",
            &path[..directory_end]
        )))
    }
}

/// An OS this build has no install rules for: nothing is trusted, so capture
/// is never registered from an unknown location.
pub struct TrustNothing;

impl InstallPolicy for TrustNothing {
    fn app_location(&self, executable: &Path) -> AppLocation {
        AppLocation {
            in_applications: false,
            path: executable.to_string_lossy().into_owned(),
        }
    }

    fn is_ephemeral(&self, _executable: &Path) -> bool {
        false
    }

    fn companion_beside_trusted_app(&self, executable: &Path) -> Result<PathBuf, CaptureError> {
        Err(not_in_applications(executable))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const DESKTOP: &str = "backplane-companion-desktop";
    const LOCAL_APP_DATA: &str = r"C:\home\me\AppData\Local";
    const WINDOWS_EXECUTABLE: &str =
        r"C:\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe";
    const WINDOWS_COMPANION: &str =
        r"C:\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion.exe";

    fn bundle_executable(root: &Path, app: &str) -> PathBuf {
        let macos = root.join(app).join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(macos.join(DESKTOP), "").unwrap();
        macos.join(DESKTOP)
    }

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let variables: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect();
        move |name| variables.get(name).cloned()
    }

    fn windows() -> Box<dyn InstallPolicy> {
        install_policy_for(
            PlatformOs::Windows,
            environment(&[("LOCALAPPDATA", LOCAL_APP_DATA)]),
        )
    }

    fn linux() -> Box<dyn InstallPolicy> {
        install_policy_for(PlatformOs::Linux, environment(&[]))
    }

    fn macos() -> Box<dyn InstallPolicy> {
        install_policy_for(PlatformOs::Macos, environment(&[]))
    }

    fn not_in_applications(outcome: Result<PathBuf, CaptureError>) -> bool {
        matches!(outcome, Err(CaptureError::NotInApplications { .. }))
    }

    #[test]
    fn install_policy_macos_accepts_applications_bundle() {
        let root = tempfile::tempdir().unwrap();
        let executable = bundle_executable(root.path(), "Backplane Companion.app");
        let companion = executable.with_file_name(COMPANION_BINARY);
        std::fs::write(&companion, "").unwrap();
        assert_eq!(
            MacosInstall::under(root.path())
                .trusted_companion(&executable)
                .unwrap(),
            companion
        );
    }

    #[test]
    fn install_policy_macos_refuses_a_missing_companion() {
        let root = tempfile::tempdir().unwrap();
        let executable = bundle_executable(root.path(), "Backplane Companion.app");
        assert!(matches!(
            MacosInstall::under(root.path()).trusted_companion(&executable),
            Err(CaptureError::NotBundled { .. })
        ));
    }

    #[test]
    fn install_policy_macos_refuses_a_dmg_or_translocated_app() {
        for prefix in [
            "/Volumes/Backplane Companion",
            "/private/var/folders/x/AppTranslocation/ABC/d",
        ] {
            let executable = PathBuf::from(prefix)
                .join("Backplane Companion.app/Contents/MacOS/backplane-companion-desktop");
            assert!(macos().is_ephemeral(&executable), "{prefix}");
            assert!(
                matches!(
                    macos().trusted_companion(&executable),
                    Err(CaptureError::EphemeralLocation { .. })
                ),
                "{prefix}"
            );
        }
    }

    #[test]
    fn install_policy_macos_refuses_an_app_outside_applications() {
        for executable in [
            "/home/me/Downloads/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/home/me/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications Old/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications/../tmp/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications/backplane-companion-desktop",
        ] {
            assert!(
                not_in_applications(macos().companion_beside_trusted_app(Path::new(executable))),
                "{executable}"
            );
        }
    }

    #[test]
    fn app_location_reports_the_bundle_inside_applications() {
        let location = macos().app_location(Path::new(
            "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
        ));
        assert_eq!(
            location,
            AppLocation {
                in_applications: true,
                path: "/Applications/Backplane Companion.app".into()
            }
        );
    }

    #[test]
    fn app_location_flags_downloads_dmg_and_translocation() {
        for executable in [
            "/home/me/Downloads/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Volumes/Backplane Companion/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/private/var/folders/x/AppTranslocation/ABC/d/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            "/Applications Old/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
        ] {
            let location = macos().app_location(Path::new(executable));
            assert!(!location.in_applications, "{executable}");
            assert!(location.path.ends_with("Backplane Companion.app"), "{executable}");
        }
    }

    #[test]
    fn app_location_outside_a_bundle_reports_the_executable() {
        let location = macos().app_location(Path::new(
            "/home/me/code/target/debug/backplane-companion-desktop",
        ));
        assert_eq!(
            location,
            AppLocation {
                in_applications: false,
                path: "/home/me/code/target/debug/backplane-companion-desktop".into()
            }
        );
    }

    #[test]
    fn install_policy_linux_accepts_usr_lib() {
        let executable = Path::new("/usr/lib/backplane-companion/backplane-companion-desktop");
        assert_eq!(
            linux().companion_beside_trusted_app(executable).unwrap(),
            PathBuf::from("/usr/lib/backplane-companion/backplane-companion")
        );
        assert!(linux().app_location(executable).in_applications);
        assert!(!linux().is_ephemeral(executable));
    }

    #[test]
    fn install_policy_linux_rejects_appimage_mount_path() {
        for executable in [
            "/tmp/.mount_x/usr/bin/backplane-companion-desktop",
            "/tmp/.mount_BackplZk3/usr/lib/backplane-companion/backplane-companion-desktop",
            "/run/user/1000/.mount_x/usr/bin/backplane-companion-desktop",
        ] {
            let executable = Path::new(executable);
            assert!(linux().is_ephemeral(executable), "{executable:?}");
            assert!(
                !linux().app_location(executable).in_applications,
                "{executable:?}"
            );
            assert!(
                matches!(
                    linux().trusted_companion(executable),
                    Err(CaptureError::EphemeralLocation { .. })
                ),
                "{executable:?}"
            );
        }
    }

    #[test]
    fn install_policy_linux_rejects_user_writable_and_look_alike_roots() {
        for executable in [
            "/home/me/.local/bin/backplane-companion-desktop",
            "/home/me/Downloads/backplane-companion-desktop",
            "/usr/lib/backplane-companion-evil/backplane-companion-desktop",
            "/usr/lib/backplane-companion/nested/backplane-companion-desktop",
            "/usr/lib/backplane-companion/../../home/me/backplane-companion-desktop",
            "/usr/local/lib/backplane-companion/backplane-companion-desktop",
            "/usr/lib/backplane-companion",
        ] {
            assert!(
                not_in_applications(linux().companion_beside_trusted_app(Path::new(executable))),
                "{executable}"
            );
        }
    }

    // AppImage staging needs Unix permissions.
    #[cfg(unix)]
    /// A running AppImage: the GUI and the companion (with its manifest) in a
    /// `.mount_` folder, the `.AppImage` file in Downloads, and a home to stage into.
    struct AppImageRun {
        _root: tempfile::TempDir,
        executable: PathBuf,
        appimage: PathBuf,
        home: PathBuf,
    }

    #[cfg(unix)]
    impl AppImageRun {
        fn new(companion: &[u8], manifest_of: &[u8]) -> Self {
            use sha2::Digest;
            let root = tempfile::tempdir().unwrap();
            let bin = root.path().join("tmp/.mount_BackplZk3/usr/bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join(DESKTOP), "").unwrap();
            std::fs::write(bin.join(COMPANION_BINARY), companion).unwrap();
            let manifest: String = sha2::Sha256::digest(manifest_of)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            std::fs::write(
                bin.join(super::super::appimage::COMPANION_MANIFEST),
                manifest,
            )
            .unwrap();
            let home = root.path().join("home/me");
            std::fs::create_dir_all(home.join("Downloads")).unwrap();
            let appimage = home.join("Downloads/Backplane_Companion-x86_64.AppImage");
            std::fs::write(&appimage, "").unwrap();
            Self {
                executable: bin.join(DESKTOP),
                appimage,
                home,
                _root: root,
            }
        }

        fn policy(&self) -> Box<dyn InstallPolicy> {
            let appimage = self.appimage.to_string_lossy().into_owned();
            let home = self.home.to_string_lossy().into_owned();
            install_policy_for(
                PlatformOs::Linux,
                environment(&[("APPIMAGE", &appimage), ("HOME", &home)]),
            )
        }

        fn staged(&self) -> PathBuf {
            self.home
                .join(".local/lib/backplane-companion")
                .join(COMPANION_BINARY)
        }
    }

    #[cfg(unix)]
    #[test]
    fn install_policy_linux_appimage_run_trusts_the_staged_companion() {
        let run = AppImageRun::new(b"companion", b"companion");

        let companion = run.policy().trusted_companion(&run.executable).unwrap();

        assert_eq!(companion, run.staged());
        assert_eq!(std::fs::read(&companion).unwrap(), b"companion");
    }

    #[cfg(unix)]
    #[test]
    fn install_policy_linux_appimage_run_reports_the_appimage_file_as_installed() {
        let run = AppImageRun::new(b"companion", b"companion");
        let location = run.policy().app_location(&run.executable);
        assert_eq!(
            location,
            AppLocation {
                in_applications: true,
                path: run.appimage.to_string_lossy().into_owned(),
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_policy_linux_appimage_removal_uses_the_staged_companion() {
        let run = AppImageRun::new(b"companion", b"companion");
        assert_eq!(
            run.policy()
                .companion_beside_trusted_app(&run.executable)
                .unwrap(),
            run.staged()
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_policy_linux_appimage_with_a_mismatched_companion_is_not_bundled() {
        let run = AppImageRun::new(b"tampered", b"companion");
        assert!(matches!(
            run.policy().trusted_companion(&run.executable),
            Err(CaptureError::NotBundled { .. })
        ));
        assert!(!run.staged().exists());
    }

    #[cfg(unix)]
    #[test]
    fn install_policy_linux_appimage_env_never_trusts_a_run_outside_a_mount() {
        let run = AppImageRun::new(b"companion", b"companion");
        for executable in [
            "/home/me/.local/bin/backplane-companion-desktop",
            "/home/me/Downloads/backplane-companion-desktop",
        ] {
            let executable = Path::new(executable);
            assert!(
                not_in_applications(run.policy().trusted_companion(executable)),
                "{executable:?}"
            );
            assert!(
                !run.policy().app_location(executable).in_applications,
                "{executable:?}"
            );
        }
        assert!(!run.staged().exists());
    }

    #[test]
    fn install_policy_windows_accepts_localappdata_programs() {
        assert_eq!(
            windows()
                .companion_beside_trusted_app(Path::new(WINDOWS_EXECUTABLE))
                .unwrap(),
            PathBuf::from(WINDOWS_COMPANION)
        );
        let location = windows().app_location(Path::new(WINDOWS_EXECUTABLE));
        assert!(location.in_applications);
        assert_eq!(location.path, WINDOWS_EXECUTABLE);
    }

    #[test]
    fn install_policy_windows_accepts_the_canonical_verbatim_form_in_any_case() {
        // std::fs::canonicalize on Windows returns the \\?\ verbatim form.
        for executable in [
            r"\\?\C:\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"c:\HOME\ME\appdata\local\programs\backplane companion\backplane-companion-desktop.exe",
            "C:/home/me/AppData/Local/Programs/Backplane Companion/backplane-companion-desktop.exe",
        ] {
            let companion = windows()
                .companion_beside_trusted_app(Path::new(executable))
                .unwrap_or_else(|error| panic!("{executable}: {error}"));
            assert!(
                companion
                    .to_string_lossy()
                    .ends_with("backplane-companion.exe"),
                "{companion:?}"
            );
        }
    }

    #[test]
    fn install_policy_windows_rejects_downloads_and_parent_dir_segments() {
        for executable in [
            r"C:\home\me\Downloads\Backplane Companion\backplane-companion-desktop.exe",
            r"C:\home\me\Downloads\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Programs\Backplane Companion\..\..\..\..\Downloads\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Programs\Backplane Companion\.\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Programs\Backplane Companion\nested\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Programs\Backplane Companion Evil\backplane-companion-desktop.exe",
            r"C:\Program Files (x86)\Backplane Companion\backplane-companion-desktop.exe",
            r"\\server\share\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"\\?\UNC\server\share\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"D:\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Programs\Backplane Companion",
        ] {
            assert!(
                not_in_applications(windows().companion_beside_trusted_app(Path::new(executable))),
                "{executable}"
            );
            assert!(
                !windows()
                    .app_location(Path::new(executable))
                    .in_applications,
                "{executable}"
            );
        }
    }

    #[test]
    fn install_policy_rejects_program_files_x86_spoof_under_downloads() {
        for executable in [
            r"C:\home\me\Downloads\Program Files (x86)\Backplane Companion\backplane-companion-desktop.exe",
            r"C:\home\me\Downloads\C\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Temp\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"C:\home\me\AppData\Local\Programs\Backplane Companion\Downloads\backplane-companion-desktop.exe",
        ] {
            assert!(
                not_in_applications(windows().trusted_companion(Path::new(executable))),
                "{executable}"
            );
        }
    }

    #[test]
    fn install_policy_windows_rejects_the_device_namespace_prefix() {
        for executable in [
            r"\\.\C:\home\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            r"//./C:/home/me/AppData/Local/Programs/Backplane Companion/backplane-companion-desktop.exe",
        ] {
            assert!(
                not_in_applications(windows().companion_beside_trusted_app(Path::new(executable))),
                "{executable}"
            );
            assert!(
                !windows()
                    .app_location(Path::new(executable))
                    .in_applications,
                "{executable}"
            );
        }
    }

    #[test]
    fn install_policy_windows_without_a_usable_localappdata_trusts_nothing() {
        for local_app_data in [
            None,
            Some(r"AppData\Local"),
            Some(""),
            Some(r"\\server\share"),
        ] {
            let pairs: Vec<(&str, &str)> = local_app_data
                .map(|value| vec![("LOCALAPPDATA", value)])
                .unwrap_or_default();
            let policy = install_policy_for(PlatformOs::Windows, environment(&pairs));
            assert!(
                not_in_applications(
                    policy.companion_beside_trusted_app(Path::new(WINDOWS_EXECUTABLE))
                ),
                "{local_app_data:?}"
            );
        }
    }

    #[test]
    fn install_policy_rejects_relative_executable() {
        for (policy, executable) in [
            (
                macos(),
                "Applications/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop",
            ),
            (
                linux(),
                "usr/lib/backplane-companion/backplane-companion-desktop",
            ),
            (
                windows(),
                r"Users\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            ),
            (
                windows(),
                r"C:Users\me\AppData\Local\Programs\Backplane Companion\backplane-companion-desktop.exe",
            ),
        ] {
            assert!(
                not_in_applications(policy.trusted_companion(Path::new(executable))),
                "{executable}"
            );
        }
    }

    #[test]
    fn unknown_os_falls_back_to_most_restrictive_policy() {
        let root = tempfile::tempdir().unwrap();
        let bundled = bundle_executable(root.path(), "Backplane Companion.app");
        std::fs::write(bundled.with_file_name(COMPANION_BINARY), "").unwrap();
        let unknown = install_policy_for(
            PlatformOs::Unknown,
            environment(&[("LOCALAPPDATA", LOCAL_APP_DATA)]),
        );
        for executable in [
            bundled.to_string_lossy().into_owned(),
            "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion-desktop"
                .into(),
            "/usr/lib/backplane-companion/backplane-companion-desktop".into(),
            WINDOWS_EXECUTABLE.into(),
        ] {
            let executable = Path::new(&executable);
            assert!(
                not_in_applications(unknown.trusted_companion(executable)),
                "{executable:?}"
            );
            assert!(
                !unknown.app_location(executable).in_applications,
                "{executable:?}"
            );
        }
    }
}
