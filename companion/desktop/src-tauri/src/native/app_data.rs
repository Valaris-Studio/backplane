// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Remove Companion's last step: the app's own folders (webview storage and
//! caches, preferences, logs). The webview recreates them while it lives, so a
//! helper copy of the app deletes them once this process has exited.

use std::ffi::OsString;
use std::io::{BufRead, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use crate::capture::{CaptureError, UninstallReport};
use crate::platform::{appimage, PlatformOs};

/// The bundle identifier (tauri.conf.json): every folder removed is named after it.
pub const APP_IDENTIFIER: &str = "dev.backplane.companion.desktop";
pub const REMOVE_APP_DATA_FLAG: &str = "--remove-app-data";
/// WebView2 helper processes can hold the Windows folder for a few seconds after the app exits.
const REMOVAL_ATTEMPTS: u32 = 20;
const REMOVAL_RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppDataOutcome {
    Removed,
    Absent,
    Refused(&'static str),
    Failed(String),
}

fn allowed_names() -> [String; 2] {
    [
        APP_IDENTIFIER.to_string(),
        format!("{APP_IDENTIFIER}.plist"),
    ]
}

/// The folders Tauri resolves for the app, plus the ones macOS's WebKit and
/// preferences keep outside the path API. Nested and repeated paths collapse.
pub fn app_data_paths(os: PlatformOs, resolved: &[PathBuf], home: &Path) -> Vec<PathBuf> {
    let mut candidates = resolved.to_vec();
    if os == PlatformOs::Macos {
        let library = home.join("Library");
        candidates.push(library.join("WebKit").join(APP_IDENTIFIER));
        candidates.push(library.join("HTTPStorages").join(APP_IDENTIFIER));
        candidates.push(
            library
                .join("Preferences")
                .join(format!("{APP_IDENTIFIER}.plist")),
        );
    }
    candidates.sort();
    candidates.dedup();
    let mut paths: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if !paths.iter().any(|kept| candidate.starts_with(kept)) {
            paths.push(candidate);
        }
    }
    paths
}

fn refusal(path: &Path, home: &Path) -> Option<&'static str> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Some("not an absolute, normalized path");
    }
    let named_for_app = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| allowed_names().iter().any(|allowed| allowed == name));
    if !named_for_app {
        return Some("not named for the app");
    }
    if path == home || !path.starts_with(home) {
        return Some("not inside the home folder");
    }
    None
}

fn remove_one(path: &Path, home: &Path) -> AppDataOutcome {
    if let Some(reason) = refusal(path, home) {
        return AppDataOutcome::Refused(reason);
    }
    remove_checked(path, home)
}

/// The path itself, never what a symlink at or above it points to.
fn unlinked_metadata(path: &Path, home: &Path) -> Result<std::fs::Metadata, AppDataOutcome> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppDataOutcome::Absent)
        }
        Err(error) => return Err(AppDataOutcome::Failed(error.to_string())),
    };
    // std reports Windows junctions as symlinks too.
    if metadata.file_type().is_symlink() {
        return Err(AppDataOutcome::Refused("a symlink"));
    }
    // A symlinked ancestor (say ~/.cache) would lead the delete outside home.
    let inside_home = match (
        path.parent().map(std::fs::canonicalize),
        std::fs::canonicalize(home),
    ) {
        (Some(Ok(parent)), Ok(home)) => parent.starts_with(home),
        _ => false,
    };
    if !inside_home {
        return Err(AppDataOutcome::Refused("reached through a symlink"));
    }
    Ok(metadata)
}

fn remove_checked(path: &Path, home: &Path) -> AppDataOutcome {
    let metadata = match unlinked_metadata(path, home) {
        Ok(metadata) => metadata,
        Err(outcome) => return outcome,
    };
    // remove_dir_all never follows symlinks inside the folder.
    let removed = if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match removed {
        Ok(()) => AppDataOutcome::Removed,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => AppDataOutcome::Absent,
        Err(error) => AppDataOutcome::Failed(error.to_string()),
    }
}

pub fn remove_app_data(paths: &[PathBuf], home: &Path) -> Vec<(PathBuf, AppDataOutcome)> {
    paths
        .iter()
        .map(|path| (path.clone(), remove_one(path, home)))
        .collect()
}

/// Every companion step finished, so its data is gone: the app's goes too.
pub fn removal_due(result: &Result<UninstallReport, CaptureError>) -> bool {
    matches!(result, Ok(_) | Err(CaptureError::LoginItemFailed { .. }))
}

pub fn removal_helper_paths(args: impl IntoIterator<Item = OsString>) -> Option<Vec<PathBuf>> {
    let mut args = args.into_iter().skip(1);
    if args.next()? != REMOVE_APP_DATA_FLAG {
        return None;
    }
    Some(args.map(PathBuf::from).collect())
}

/// An AppImage's own mount vanishes with the app, so the helper runs the AppImage.
pub fn helper_executable(current_exe: PathBuf, appimage: Option<OsString>) -> PathBuf {
    match appimage.map(PathBuf::from) {
        Some(appimage) if appimage.is_absolute() => appimage,
        _ => current_exe,
    }
}

pub fn helper_command(executable: &Path, paths: &[PathBuf]) -> Command {
    let mut command = Command::new(executable);
    command
        .arg(REMOVE_APP_DATA_FLAG)
        .args(paths)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

struct ArmedRemoval {
    paths: Vec<PathBuf>,
    token: RemovalToken,
}

/// Set once Remove Companion finished; the app's folders go when it exits.
#[derive(Default)]
pub struct PendingAppDataRemoval(Mutex<Option<ArmedRemoval>>);

impl PendingAppDataRemoval {
    /// Mints the one-time token and leaves it in `token_dir` (one of `paths`),
    /// where the helper looks for it.
    pub fn arm(&self, paths: Vec<PathBuf>, token_dir: &Path) -> std::io::Result<()> {
        let token = RemovalToken::mint()?;
        write_token_file(&token_dir.join(REMOVAL_TOKEN_FILE), &token)?;
        *self.lock() = Some(ArmedRemoval { paths, token });
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ArmedRemoval>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    fn armed_token(&self) -> Option<RemovalToken> {
        self.lock().as_ref().map(|armed| armed.token.clone())
    }
}

fn write_token_file(file: &Path, token: &RemovalToken) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A planted symlink is removed, not written through: create_new never follows one.
    match std::fs::remove_file(file) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)?.write_all(token.0.as_bytes())
}

/// At exit: hands the armed folders to a helper, which waits for this process
/// to be gone (its stdin closes with it) before deleting anything.
pub fn spawn_helper_if_armed(pending: &PendingAppDataRemoval) {
    let Some(armed) = pending.lock().take() else {
        return;
    };
    let executable = match std::env::current_exe() {
        Ok(executable) => helper_executable(executable, std::env::var_os("APPIMAGE")),
        Err(error) => {
            log::warn!("app data left behind: no executable for the helper: {error}");
            return;
        }
    };
    let mut helper = match helper_command(&executable, &armed.paths).spawn() {
        Ok(helper) => helper,
        Err(error) => {
            log::warn!("app data left behind: the helper did not start: {error}");
            return;
        }
    };
    let Some(mut stdin) = helper.stdin.take() else {
        return;
    };
    if let Err(error) = writeln!(stdin, "{}", armed.token.0) {
        log::warn!("app data left behind: the helper did not get its token: {error}");
    }
    // The pipe's write end must outlive this function: the OS closes it
    // only when this process exits, which is the helper's signal.
    std::mem::forget(stdin);
}

/// The helper's whole life, before any Tauri set-up (which would recreate the folders).
pub fn run_removal_helper(paths: &[PathBuf]) -> std::process::ExitCode {
    let Some(home) = std::env::home_dir() else {
        return std::process::ExitCode::FAILURE;
    };
    match run_removal_helper_with(&mut std::io::stdin().lock(), paths, &home) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => std::process::ExitCode::FAILURE,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperRefusal {
    NoToken,
    WrongToken,
}

/// Proves a helper was started by a real Remove: only the armed app wrote it,
/// and only into its own folder and the helper's stdin, never argv or the environment.
#[derive(Clone, PartialEq, Eq)]
pub struct RemovalToken(String);

impl RemovalToken {
    pub fn mint() -> std::io::Result<Self> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
        Ok(Self(
            bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        ))
    }

    fn matches(&self, candidate: &str) -> bool {
        self.0.len() == candidate.len()
            && self
                .0
                .bytes()
                .zip(candidate.bytes())
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                == 0
    }
}

pub const REMOVAL_TOKEN_FILE: &str = ".removal-token";

/// Only a token found in one of the named app folders counts; argv alone can
/// never start a delete.
fn token_armed_in(paths: &[PathBuf], home: &Path, token: &RemovalToken) -> bool {
    paths.iter().any(|dir| {
        if refusal(dir, home).is_some()
            || !unlinked_metadata(dir, home).is_ok_and(|meta| meta.is_dir())
        {
            return false;
        }
        let file = dir.join(REMOVAL_TOKEN_FILE);
        let is_plain_file =
            std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.file_type().is_file());
        is_plain_file
            && std::fs::read_to_string(&file).is_ok_and(|stored| token.matches(stored.trim()))
    })
}

pub fn run_removal_helper_with(
    stdin: &mut impl std::io::BufRead,
    paths: &[PathBuf],
    home: &Path,
) -> Result<(), HelperRefusal> {
    let mut line = String::new();
    // Bounded: the token is 64 characters.
    let _ = stdin.by_ref().take(256).read_line(&mut line);
    let offered = line.trim();
    if offered.is_empty() {
        return Err(HelperRefusal::NoToken);
    }
    if !token_armed_in(paths, home, &RemovalToken(offered.to_string())) {
        return Err(HelperRefusal::WrongToken);
    }
    let _ = stdin.read_to_end(&mut Vec::new());
    let mut remaining = paths.to_vec();
    for attempt in 0..REMOVAL_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(REMOVAL_RETRY_DELAY);
        }
        remaining = remove_app_data(&remaining, home)
            .into_iter()
            .filter(|(_, outcome)| matches!(outcome, AppDataOutcome::Failed(_)))
            .map(|(path, _)| path)
            .collect();
        if remaining.is_empty() {
            break;
        }
    }
    Ok(())
}

/// The AppImage's staged companion (Linux): exactly that folder, under the same rules.
pub fn remove_appimage_staging(home: &Path) -> AppDataOutcome {
    remove_checked(&appimage::staging_dir(home), home)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_HOME: &str = "/home/me";

    fn under(home: &Path, parts: &[&str]) -> PathBuf {
        parts
            .iter()
            .fold(home.to_path_buf(), |path, part| path.join(part))
    }

    #[test]
    fn app_identifier_matches_the_bundle_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn app_data_paths_on_macos_add_webkit_and_preferences_and_collapse_repeats() {
        let home = Path::new("/home/me");
        let support = under(home, &["Library", "Application Support", APP_IDENTIFIER]);
        let caches = under(home, &["Library", "Caches", APP_IDENTIFIER]);
        let logs = under(home, &["Library", "Logs", APP_IDENTIFIER]);
        let resolved = [
            support.clone(),
            support.clone(),
            support.clone(),
            caches.clone(),
            logs.clone(),
        ];
        let mut paths = app_data_paths(PlatformOs::Macos, &resolved, home);
        paths.sort();
        let mut expected = vec![
            support,
            caches,
            logs,
            under(home, &["Library", "WebKit", APP_IDENTIFIER]),
            under(home, &["Library", "HTTPStorages", APP_IDENTIFIER]),
            under(
                home,
                &["Library", "Preferences", &format!("{APP_IDENTIFIER}.plist")],
            ),
        ];
        expected.sort();
        assert_eq!(paths, expected);
    }

    #[test]
    fn app_data_paths_elsewhere_are_the_resolved_folders_without_nested_ones() {
        let home = Path::new(LINUX_HOME);
        let config = under(home, &[".config", APP_IDENTIFIER]);
        let data = under(home, &[".local", "share", APP_IDENTIFIER]);
        let cache = under(home, &[".cache", APP_IDENTIFIER]);
        let resolved = [
            config.clone(),
            data.clone(),
            data.clone(),
            cache.clone(),
            data.join("logs"),
        ];
        let mut paths = app_data_paths(PlatformOs::Linux, &resolved, home);
        paths.sort();
        let mut expected = vec![config, data, cache];
        expected.sort();
        assert_eq!(paths, expected);
    }

    fn app_dir(home: &Path, parts: &[&str]) -> PathBuf {
        let dir = under(home, parts).join(APP_IDENTIFIER);
        std::fs::create_dir_all(dir.join("EBWebView").join("Default")).unwrap();
        std::fs::write(dir.join("EBWebView").join("Default").join("Cookies"), "c").unwrap();
        dir
    }

    #[test]
    fn remove_app_data_deletes_the_app_folders_and_nothing_beside_them() {
        let home = tempfile::tempdir().unwrap();
        let config = app_dir(home.path(), &[".config"]);
        let local = app_dir(home.path(), &["AppData", "Local"]);
        let preferences = under(home.path(), &["Library", "Preferences"]);
        std::fs::create_dir_all(&preferences).unwrap();
        let plist = preferences.join(format!("{APP_IDENTIFIER}.plist"));
        std::fs::write(&plist, "p").unwrap();
        let neighbour = under(home.path(), &["AppData", "Local", "Backplane"]);
        std::fs::create_dir_all(&neighbour).unwrap();
        let other_plist = preferences.join("com.example.other.plist");
        std::fs::write(&other_plist, "o").unwrap();

        let outcomes =
            remove_app_data(&[config.clone(), local.clone(), plist.clone()], home.path());

        assert!(
            outcomes
                .iter()
                .all(|(_, outcome)| *outcome == AppDataOutcome::Removed),
            "{outcomes:?}"
        );
        for removed in [&config, &local, &plist] {
            assert!(std::fs::symlink_metadata(removed).is_err(), "{removed:?}");
        }
        assert!(neighbour.is_dir());
        assert!(other_plist.is_file());
    }

    #[test]
    fn remove_app_data_reports_a_missing_folder_as_absent() {
        let home = tempfile::tempdir().unwrap();
        let missing = under(home.path(), &[".cache", APP_IDENTIFIER]);
        assert_eq!(
            remove_app_data(std::slice::from_ref(&missing), home.path()),
            vec![(missing, AppDataOutcome::Absent)]
        );
    }

    #[test]
    fn remove_app_data_refuses_paths_outside_home_or_not_named_for_the_app() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_app = app_dir(outside.path(), &["share"]);
        let wrong_name = under(home.path(), &[".config", "backplane"]);
        std::fs::create_dir_all(&wrong_name).unwrap();
        let dotdot = under(home.path(), &[".config", "..", "..", APP_IDENTIFIER]);

        let outcomes = remove_app_data(
            &[
                outside_app.clone(),
                wrong_name.clone(),
                home.path().to_path_buf(),
                dotdot,
                PathBuf::from(APP_IDENTIFIER),
            ],
            home.path(),
        );

        assert!(
            outcomes
                .iter()
                .all(|(_, outcome)| matches!(outcome, AppDataOutcome::Refused(_))),
            "{outcomes:?}"
        );
        assert!(outside_app.join("EBWebView").is_dir());
        assert!(wrong_name.is_dir());
        assert!(home.path().is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn remove_app_data_refuses_a_symlinked_app_folder() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = app_dir(elsewhere.path(), &["real"]);
        let config = under(home.path(), &[".config"]);
        std::fs::create_dir_all(&config).unwrap();
        let link = config.join(APP_IDENTIFIER);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let outcomes = remove_app_data(std::slice::from_ref(&link), home.path());

        assert!(
            matches!(outcomes[0].1, AppDataOutcome::Refused(_)),
            "{outcomes:?}"
        );
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(target
            .join("EBWebView")
            .join("Default")
            .join("Cookies")
            .is_file());
    }

    #[cfg(unix)]
    #[test]
    fn remove_app_data_refuses_a_folder_reached_through_a_symlinked_parent() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = app_dir(elsewhere.path(), &["cache"]);
        std::os::unix::fs::symlink(elsewhere.path().join("cache"), home.path().join(".cache"))
            .unwrap();

        let outcomes = remove_app_data(
            &[under(home.path(), &[".cache", APP_IDENTIFIER])],
            home.path(),
        );

        assert!(
            matches!(outcomes[0].1, AppDataOutcome::Refused(_)),
            "{outcomes:?}"
        );
        assert!(target.join("EBWebView").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn remove_app_data_never_follows_a_symlink_inside_the_folder() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let precious = elsewhere.path().join("precious.txt");
        std::fs::write(&precious, "keep").unwrap();
        let config = app_dir(home.path(), &[".config"]);
        std::os::unix::fs::symlink(elsewhere.path(), config.join("escape")).unwrap();

        let outcomes = remove_app_data(std::slice::from_ref(&config), home.path());

        assert_eq!(outcomes[0].1, AppDataOutcome::Removed);
        assert!(!config.exists());
        assert!(precious.is_file());
    }

    #[test]
    fn removal_is_due_once_every_companion_step_finished() {
        let report = UninstallReport {
            uninstalled: true,
            server_revoked: false,
        };
        assert!(removal_due(&Ok(report.clone())));
        assert!(removal_due(&Err(CaptureError::LoginItemFailed {
            message: "denied".into(),
            report,
        })));
        for failed in [
            CaptureError::CompanionFailed {
                step: "uninstall --purge".into(),
                exit_code: Some(1),
                message: String::new(),
            },
            CaptureError::Protocol {
                step: "uninstall --purge".into(),
                message: String::new(),
            },
            CaptureError::NotInApplications {
                path: String::new(),
            },
        ] {
            assert!(!removal_due(&Err(failed)));
        }
    }

    #[test]
    fn removal_helper_paths_only_for_the_helper_flag() {
        let args = |items: &[&str]| items.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(removal_helper_paths(args(&["app"])), None);
        assert_eq!(removal_helper_paths(args(&["app", "--other", "/x"])), None);
        assert_eq!(
            removal_helper_paths(args(&["app", REMOVE_APP_DATA_FLAG, "/a", "/b"])),
            Some(vec![PathBuf::from("/a"), PathBuf::from("/b")])
        );
    }

    #[test]
    fn helper_command_passes_the_flag_then_the_paths() {
        let paths = [PathBuf::from("/h/.config").join(APP_IDENTIFIER)];
        let command = helper_command(Path::new("/opt/app/backplane-companion-desktop"), &paths);
        assert_eq!(
            command.get_program(),
            "/opt/app/backplane-companion-desktop"
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(
            args,
            [
                OsString::from(REMOVE_APP_DATA_FLAG).as_os_str(),
                paths[0].as_os_str()
            ]
        );
    }

    #[test]
    fn helper_executable_prefers_the_appimage_over_its_vanishing_mount() {
        let mounted = PathBuf::from("/tmp/.mount_abc/usr/bin/backplane-companion-desktop");
        assert_eq!(
            helper_executable(
                mounted.clone(),
                Some("/home/me/Apps/Backplane.AppImage".into())
            ),
            PathBuf::from("/home/me/Apps/Backplane.AppImage")
        );
        assert_eq!(
            helper_executable(mounted.clone(), Some("relative.AppImage".into())),
            mounted
        );
        assert_eq!(helper_executable(mounted.clone(), None), mounted);
    }

    fn armed_in(home: &Path) -> (PendingAppDataRemoval, PathBuf, PathBuf) {
        let local = app_dir(home, &[".local", "share"]);
        let cache = app_dir(home, &[".cache"]);
        let pending = PendingAppDataRemoval::default();
        pending
            .arm(vec![local.clone(), cache.clone()], &local)
            .unwrap();
        (pending, local, cache)
    }

    /// Records whether the watched folder still existed when stdin reached EOF.
    struct EofProbe {
        input: std::io::Cursor<Vec<u8>>,
        watched: PathBuf,
        existed_at_eof: std::rc::Rc<std::cell::Cell<Option<bool>>>,
    }

    impl Read for EofProbe {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let read = self.input.read(buf)?;
            if read == 0 && self.existed_at_eof.get().is_none() {
                self.existed_at_eof.set(Some(self.watched.exists()));
            }
            Ok(read)
        }
    }

    #[test]
    fn helper_with_the_armed_token_deletes_only_after_eof() {
        let home = tempfile::tempdir().unwrap();
        let (pending, local, cache) = armed_in(home.path());
        let token = pending.armed_token().unwrap();
        let existed_at_eof = std::rc::Rc::new(std::cell::Cell::new(None));
        let mut stdin = std::io::BufReader::new(EofProbe {
            input: std::io::Cursor::new(format!("{}\n", token.0).into_bytes()),
            watched: cache.clone(),
            existed_at_eof: existed_at_eof.clone(),
        });

        let result =
            run_removal_helper_with(&mut stdin, &[local.clone(), cache.clone()], home.path());

        assert_eq!(result, Ok(()));
        assert_eq!(
            existed_at_eof.get(),
            Some(true),
            "nothing is deleted before EOF"
        );
        assert!(!local.exists() && !cache.exists());
    }

    #[test]
    fn helper_without_a_token_deletes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let (_pending, local, cache) = armed_in(home.path());
        let mut stdin = std::io::Cursor::new(Vec::new());
        assert_eq!(
            run_removal_helper_with(&mut stdin, &[local.clone(), cache.clone()], home.path()),
            Err(HelperRefusal::NoToken)
        );
        assert!(local.join("EBWebView").is_dir() && cache.join("EBWebView").is_dir());
    }

    #[test]
    fn helper_with_a_wrong_token_deletes_nothing() {
        let home = tempfile::tempdir().unwrap();
        let (_pending, local, cache) = armed_in(home.path());
        let forged = RemovalToken::mint().unwrap();
        let mut stdin = std::io::Cursor::new(format!("{}\n", forged.0).into_bytes());
        assert_eq!(
            run_removal_helper_with(&mut stdin, &[local.clone(), cache.clone()], home.path()),
            Err(HelperRefusal::WrongToken)
        );
        assert!(local.join("EBWebView").is_dir() && cache.join("EBWebView").is_dir());
    }

    #[test]
    fn helper_ignores_a_token_file_outside_an_app_folder() {
        let home = tempfile::tempdir().unwrap();
        let decoy = under(home.path(), &[".config", "decoy"]);
        std::fs::create_dir_all(&decoy).unwrap();
        std::fs::write(decoy.join(REMOVAL_TOKEN_FILE), "0123").unwrap();
        let cache = app_dir(home.path(), &[".cache"]);
        let mut stdin = std::io::Cursor::new(b"0123\n".to_vec());
        assert_eq!(
            run_removal_helper_with(&mut stdin, &[decoy.clone(), cache.clone()], home.path()),
            Err(HelperRefusal::WrongToken)
        );
        assert!(cache.join("EBWebView").is_dir());
    }

    #[test]
    fn minted_tokens_are_256_bit_hex_and_never_repeat() {
        let first = RemovalToken::mint().unwrap();
        let second = RemovalToken::mint().unwrap();
        assert_eq!(first.0.len(), 64);
        assert!(first.0.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(first != second);
    }

    #[cfg(unix)]
    #[test]
    fn arm_writes_the_token_file_for_this_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let (pending, local, _cache) = armed_in(home.path());
        let file = local.join(REMOVAL_TOKEN_FILE);
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            pending.armed_token().unwrap().0
        );
    }

    #[test]
    fn the_spawned_argv_never_carries_the_token() {
        let home = tempfile::tempdir().unwrap();
        let (pending, local, cache) = armed_in(home.path());
        let token = pending.armed_token().unwrap();
        let command = helper_command(
            Path::new("/opt/app/backplane-companion-desktop"),
            &[local, cache],
        );
        assert!(command
            .get_args()
            .all(|arg| !arg.to_string_lossy().contains(&token.0)));
        assert!(command.get_envs().all(|(name, value)| {
            !name.to_string_lossy().contains(&token.0)
                && !value.is_some_and(|value| value.to_string_lossy().contains(&token.0))
        }));
    }

    fn staging_in(home: &Path) -> PathBuf {
        let staging = under(home, &[".local", "lib", "backplane-companion"]);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("backplane-companion"), "elf").unwrap();
        staging
    }

    #[test]
    fn remove_appimage_staging_removes_only_the_staging_folder() {
        let home = tempfile::tempdir().unwrap();
        let staging = staging_in(home.path());
        let neighbour = under(home.path(), &[".local", "lib", "other-tool"]);
        std::fs::create_dir_all(&neighbour).unwrap();
        assert_eq!(
            remove_appimage_staging(home.path()),
            AppDataOutcome::Removed
        );
        assert!(!staging.exists());
        assert!(neighbour.is_dir());
        assert_eq!(remove_appimage_staging(home.path()), AppDataOutcome::Absent);
    }

    #[cfg(unix)]
    #[test]
    fn remove_appimage_staging_refuses_a_symlinked_staging_folder() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = staging_in(elsewhere.path());
        let lib = under(home.path(), &[".local", "lib"]);
        std::fs::create_dir_all(&lib).unwrap();
        std::os::unix::fs::symlink(&target, lib.join("backplane-companion")).unwrap();
        assert!(matches!(
            remove_appimage_staging(home.path()),
            AppDataOutcome::Refused(_)
        ));
        assert!(target.join("backplane-companion").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn remove_appimage_staging_refuses_a_symlinked_local_lib() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = staging_in(elsewhere.path());
        std::fs::create_dir_all(home.path().join(".local")).unwrap();
        std::os::unix::fs::symlink(
            elsewhere.path().join(".local").join("lib"),
            home.path().join(".local").join("lib"),
        )
        .unwrap();
        assert!(matches!(
            remove_appimage_staging(home.path()),
            AppDataOutcome::Refused(_)
        ));
        assert!(target.join("backplane-companion").is_file());
    }
}
