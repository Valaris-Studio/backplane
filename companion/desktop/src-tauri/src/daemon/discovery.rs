// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Finds the daemon's control socket the same way the Go store finds its data
//! directory (`companion/internal/store.DefaultRoot`), then via control.json.

use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const ENV_HOME: &str = "BACKPLANE_COMPANION_HOME";
pub const CONTROL_FILE: &str = "control.json";
/// The Go control pipe prefix, followed by the user's SID and data-directory digest.
const CONTROL_PIPE_PREFIX: &str = r"\\.\pipe\backplane-companion-";
const SUPPORTED_CONTROL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DiscoveryError {
    #[error("{ENV_HOME} must be an absolute path")]
    OverrideNotAbsolute,
    #[error("the home directory is unknown")]
    HomeUnknown,
    #[error("control.json is missing; the daemon is not running")]
    ControlFileMissing,
    #[error("control.json is unreadable: {0}")]
    ControlFileInvalid(String),
    #[error("control.json version {0} is not supported")]
    UnsupportedVersion(u32),
    #[error("control.json names a relative socket path")]
    SocketNotAbsolute,
    #[error("control.json names a socket outside the data directory")]
    SocketOutsideDataDir,
    #[error("the current Windows user could not be identified")]
    UserUnknown,
    #[error("control.json names a pipe that is not this user's control pipe")]
    PipeNotOwnUser,
    #[error("control.json names a pipe for another data directory")]
    PipeOutsideDataDir,
}

impl DiscoveryError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::OverrideNotAbsolute => "override_not_absolute",
            Self::HomeUnknown => "home_unknown",
            Self::ControlFileMissing => "control_file_missing",
            Self::ControlFileInvalid(_) => "control_file_invalid",
            Self::UnsupportedVersion(_) => "control_file_unsupported",
            Self::SocketNotAbsolute => "control_file_invalid",
            Self::SocketOutsideDataDir => "socket_outside_data_dir",
            Self::UserUnknown => "user_unknown",
            Self::PipeNotOwnUser => "pipe_not_own_user",
            Self::PipeOutsideDataDir => "pipe_outside_data_dir",
        }
    }
}

#[derive(Debug, Deserialize)]
struct ControlFile {
    version: u32,
    socket: String,
}

pub fn default_data_dir(
    getenv: impl Fn(&str) -> Option<String>,
    os: &str,
    home: Option<&Path>,
) -> Result<PathBuf, DiscoveryError> {
    if let Some(override_dir) = getenv(ENV_HOME).filter(|value| !value.is_empty()) {
        let override_dir = PathBuf::from(override_dir);
        if !override_dir.is_absolute() {
            return Err(DiscoveryError::OverrideNotAbsolute);
        }
        return Ok(override_dir);
    }
    let home = home.ok_or(DiscoveryError::HomeUnknown)?;
    Ok(match os {
        "macos" => home
            .join("Library")
            .join("Application Support")
            .join("Backplane Companion"),
        "windows" => getenv("LOCALAPPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("Backplane")
            .join("Companion"),
        _ => getenv("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|base| base.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("state"))
            .join("backplane-companion"),
    })
}

/// The home directory the Go daemon resolves (`os.UserHomeDir`): USERPROFILE
/// on Windows, HOME elsewhere.
pub fn home_dir(getenv: impl Fn(&str) -> Option<String>, os: &str) -> Option<PathBuf> {
    let variable = if os == "windows" {
        "USERPROFILE"
    } else {
        "HOME"
    };
    getenv(variable)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The pipe `control.json` names on Windows, accepted only when it is exactly
/// this user's scoped control pipe. The data directory supplies the digest;
/// the SID must match independently. Legacy SID-only pipes are never a fallback.
pub fn own_user_pipe(socket: &str, user_sid: &str) -> Result<PathBuf, DiscoveryError> {
    if !is_sid(user_sid) {
        return Err(DiscoveryError::UserUnknown);
    }
    let prefix = format!("{CONTROL_PIPE_PREFIX}{user_sid}-");
    let valid_digest = socket.strip_prefix(&prefix).is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if !valid_digest {
        return Err(DiscoveryError::PipeNotOwnUser);
    }
    Ok(PathBuf::from(socket))
}

/// `S-1-<authority>-<subauthority>...`, as the Go daemon's `sidPattern`.
fn is_sid(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("S-1-") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub fn data_dir_from_environment() -> Result<PathBuf, DiscoveryError> {
    let getenv = |key: &str| std::env::var(key).ok();
    let home = home_dir(getenv, std::env::consts::OS);
    default_data_dir(getenv, std::env::consts::OS, home.as_deref())
}

pub fn resolve_socket(data_dir: &Path) -> Result<PathBuf, DiscoveryError> {
    let raw = match std::fs::read(data_dir.join(CONTROL_FILE)) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(DiscoveryError::ControlFileMissing)
        }
        Err(error) => return Err(DiscoveryError::ControlFileInvalid(error.to_string())),
    };
    let control: ControlFile = serde_json::from_slice(&raw)
        .map_err(|error| DiscoveryError::ControlFileInvalid(error.to_string()))?;
    if control.version != SUPPORTED_CONTROL_VERSION {
        return Err(DiscoveryError::UnsupportedVersion(control.version));
    }
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};

        let user_sid =
            super::windows_identity::current_user_sid().map_err(|_| DiscoveryError::UserUnknown)?;
        let socket = own_user_pipe(&control.socket, &user_sid)?;
        // Windows canonicalize returns the final handle's verbatim DOS path,
        // matching Go's scopedPipeName even through a directory junction.
        let canonical = data_dir
            .canonicalize()
            .map_err(|error| DiscoveryError::ControlFileInvalid(error.to_string()))?;
        let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
        if control.socket != format!("{CONTROL_PIPE_PREFIX}{user_sid}-{digest:x}") {
            return Err(DiscoveryError::PipeOutsideDataDir);
        }
        Ok(socket)
    }
    #[cfg(not(windows))]
    {
        let socket = PathBuf::from(control.socket);
        if !socket.is_absolute() {
            return Err(DiscoveryError::SocketNotAbsolute);
        }
        confine_to_data_dir(&socket, data_dir)
    }
}

/// control.json is only as trustworthy as the data dir: the socket must live
/// in it, with no `..` hops and no symlink (directory or socket) leading out.
#[cfg(not(windows))]
fn confine_to_data_dir(socket: &Path, data_dir: &Path) -> Result<PathBuf, DiscoveryError> {
    use std::path::Component;
    let outside = || DiscoveryError::SocketOutsideDataDir;
    if socket
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(outside());
    }
    let canonical_data_dir = data_dir
        .canonicalize()
        .map_err(|error| DiscoveryError::ControlFileInvalid(error.to_string()))?;
    let (Some(parent), Some(file_name)) = (socket.parent(), socket.file_name()) else {
        return Err(outside());
    };
    let canonical_parent = parent.canonicalize().map_err(|_| outside())?;
    if !canonical_parent.starts_with(&canonical_data_dir) {
        return Err(outside());
    }
    let resolved = canonical_parent.join(file_name);
    let is_symlink = std::fs::symlink_metadata(&resolved)
        .is_ok_and(|metadata| metadata.file_type().is_symlink());
    if is_symlink {
        return Err(outside());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    const HOME: &str = "/home/tester";

    #[test]
    fn default_data_dir_prefers_absolute_override_on_every_os() {
        for os in ["macos", "linux", "windows"] {
            let dir = default_data_dir(
                env(&[(ENV_HOME, "/tmp/bpc-home")]),
                os,
                Some(Path::new(HOME)),
            );
            assert_eq!(dir, Ok(PathBuf::from("/tmp/bpc-home")), "os={os}");
        }
    }

    #[test]
    fn default_data_dir_rejects_relative_override() {
        let dir = default_data_dir(
            env(&[(ENV_HOME, "relative/home")]),
            "macos",
            Some(Path::new(HOME)),
        );
        assert_eq!(dir, Err(DiscoveryError::OverrideNotAbsolute));
    }

    #[test]
    fn default_data_dir_uses_application_support_on_macos() {
        let dir = default_data_dir(env(&[]), "macos", Some(Path::new(HOME)));
        assert_eq!(
            dir,
            Ok(PathBuf::from(
                "/home/tester/Library/Application Support/Backplane Companion"
            ))
        );
    }

    #[test]
    fn default_data_dir_uses_absolute_xdg_state_home_on_linux() {
        let dir = default_data_dir(
            env(&[("XDG_STATE_HOME", "/var/state")]),
            "linux",
            Some(Path::new(HOME)),
        );
        assert_eq!(dir, Ok(PathBuf::from("/var/state/backplane-companion")));
    }

    #[test]
    fn default_data_dir_ignores_relative_xdg_state_home_on_linux() {
        let dir = default_data_dir(
            env(&[("XDG_STATE_HOME", "state")]),
            "linux",
            Some(Path::new(HOME)),
        );
        assert_eq!(
            dir,
            Ok(PathBuf::from(
                "/home/tester/.local/state/backplane-companion"
            ))
        );
    }

    #[test]
    fn default_data_dir_without_home_fails() {
        assert_eq!(
            default_data_dir(env(&[]), "macos", None),
            Err(DiscoveryError::HomeUnknown)
        );
    }

    fn write_control(dir: &Path, body: &str) {
        std::fs::write(dir.join(CONTROL_FILE), body).unwrap();
    }

    #[test]
    #[cfg(not(windows))]
    fn resolve_socket_reads_control_json() {
        let dir = tempfile::tempdir().unwrap();
        write_control(
            dir.path(),
            &format!(
                r#"{{"version":1,"socket":"{}/control.sock","pid":42,"started_at":"2026-09-28T10:00:00Z"}}"#,
                dir.path().display()
            ),
        );
        assert_eq!(
            resolve_socket(dir.path()),
            Ok(canonical(dir.path()).join("control.sock"))
        );
    }

    #[cfg(not(windows))]
    fn write_control_for(dir: &Path, socket: &Path) {
        write_control(
            dir,
            &format!(
                r#"{{"version":1,"socket":"{}","pid":1,"started_at":"x"}}"#,
                socket.display()
            ),
        );
    }

    #[cfg(not(windows))]
    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().unwrap()
    }

    #[test]
    #[cfg(not(windows))]
    fn resolve_socket_rejects_a_socket_outside_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        write_control_for(dir.path(), &elsewhere.path().join("control.sock"));
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::SocketOutsideDataDir)
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn resolve_socket_rejects_a_dot_dot_escape() {
        let dir = tempfile::tempdir().unwrap();
        write_control_for(dir.path(), &dir.path().join("..").join("control.sock"));
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::SocketOutsideDataDir)
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn resolve_socket_rejects_a_dot_dot_that_lands_back_inside() {
        let dir = tempfile::tempdir().unwrap();
        let name = dir.path().file_name().unwrap().to_owned();
        write_control_for(
            dir.path(),
            &dir.path().join("..").join(name).join("control.sock"),
        );
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::SocketOutsideDataDir)
        );
    }

    #[test]
    #[cfg(unix)]
    fn resolve_socket_rejects_a_symlinked_directory_escape() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("run")).unwrap();
        write_control_for(dir.path(), &dir.path().join("run").join("control.sock"));
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::SocketOutsideDataDir)
        );
    }

    #[test]
    #[cfg(unix)]
    fn resolve_socket_rejects_a_socket_path_that_is_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("real.sock");
        std::fs::write(&target, b"").unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("control.sock")).unwrap();
        write_control_for(dir.path(), &dir.path().join("control.sock"));
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::SocketOutsideDataDir)
        );
    }

    #[test]
    fn resolve_socket_without_control_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::ControlFileMissing)
        );
    }

    #[test]
    fn resolve_socket_rejects_malformed_control_file() {
        let dir = tempfile::tempdir().unwrap();
        write_control(dir.path(), "{not json");
        assert!(matches!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::ControlFileInvalid(_))
        ));
    }

    #[test]
    fn resolve_socket_rejects_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        write_control(
            dir.path(),
            r#"{"version":2,"socket":"/tmp/x.sock","pid":1,"started_at":"x"}"#,
        );
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::UnsupportedVersion(2))
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn resolve_socket_rejects_relative_socket_path() {
        let dir = tempfile::tempdir().unwrap();
        write_control(
            dir.path(),
            r#"{"version":1,"socket":"control.sock","pid":1,"started_at":"x"}"#,
        );
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::SocketNotAbsolute)
        );
    }

    const OWN_SID: &str = "S-1-5-21-3623811015-3361044348-30300820-1013";
    const ROOT_DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn discovery_accepts_own_sid_data_directory_pipe() {
        let pipe = format!(r"\\.\pipe\backplane-companion-{OWN_SID}-{ROOT_DIGEST}");
        assert_eq!(own_user_pipe(&pipe, OWN_SID), Ok(PathBuf::from(pipe)));
    }

    #[test]
    fn discovery_rejects_legacy_sid_only_pipe() {
        let pipe = format!(r"\\.\pipe\backplane-companion-{OWN_SID}");
        assert_eq!(
            own_user_pipe(&pipe, OWN_SID),
            Err(DiscoveryError::PipeNotOwnUser)
        );
    }

    #[cfg(windows)]
    fn expected_windows_pipe(data_dir: &Path) -> String {
        use sha2::{Digest, Sha256};
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFinalPathNameByHandleW, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        // The wire identity is the OS-resolved verbatim path, hashed as UTF-8.
        // Derive the expected value without calling a discovery implementation helper.
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(data_dir)
            .unwrap();
        let mut buffer = vec![0_u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                directory.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        assert!(length > 0 && (length as usize) < buffer.len());
        let canonical = String::from_utf16(&buffer[..length as usize]).unwrap();
        let digest = Sha256::digest(canonical.as_bytes());
        let sid = super::super::windows_identity::current_user_sid().unwrap();
        format!(r"\\.\pipe\backplane-companion-{sid}-{digest:x}")
    }

    #[cfg(windows)]
    fn write_windows_control(data_dir: &Path, socket: &str) {
        let control = serde_json::json!({
            "version": 1, "socket": socket, "pid": 42,
            "started_at": "2026-10-12T02:00:00Z"
        });
        write_control(data_dir, &control.to_string());
    }

    #[test]
    #[cfg(windows)]
    fn resolve_socket_reads_scoped_control_json_and_rejects_legacy() {
        let dir = tempfile::Builder::new()
            .prefix("Desktop home café ")
            .tempdir()
            .unwrap();
        let scoped = expected_windows_pipe(dir.path());
        write_windows_control(dir.path(), &scoped);
        assert_eq!(resolve_socket(dir.path()), Ok(PathBuf::from(&scoped)));

        let sid = super::super::windows_identity::current_user_sid().unwrap();
        write_windows_control(dir.path(), &format!(r"\\.\pipe\backplane-companion-{sid}"));
        assert_eq!(
            resolve_socket(dir.path()),
            Err(DiscoveryError::PipeNotOwnUser)
        );
    }

    #[test]
    #[cfg(windows)]
    fn resolve_socket_rejects_control_file_copied_from_another_home() {
        let parent = tempfile::tempdir().unwrap();
        let home_a = parent.path().join("home A café");
        let home_b = parent.path().join("home B café");
        std::fs::create_dir(&home_a).unwrap();
        std::fs::create_dir(&home_b).unwrap();
        let pipe_a = expected_windows_pipe(&home_a);
        let pipe_b = expected_windows_pipe(&home_b);
        assert_ne!(
            pipe_a, pipe_b,
            "fixture homes must have distinct pipe identities"
        );
        write_windows_control(&home_a, &pipe_a);
        std::fs::copy(home_a.join(CONTROL_FILE), home_b.join(CONTROL_FILE)).unwrap();

        assert_eq!(resolve_socket(&home_a), Ok(PathBuf::from(&pipe_a)));
        assert!(
            resolve_socket(&home_b).is_err(),
            "home B accepted home A's own-user pipe from a copied control file"
        );
        write_windows_control(&home_b, &pipe_b);
        assert_eq!(resolve_socket(&home_b), Ok(PathBuf::from(&pipe_b)));
    }

    #[test]
    #[cfg(windows)]
    fn resolve_socket_rejects_a_replaced_data_directory_digest() {
        let dir = tempfile::tempdir().unwrap();
        let expected = expected_windows_pipe(dir.path());
        let sid = super::super::windows_identity::current_user_sid().unwrap();
        let mut replaced = expected.clone();
        let last = replaced.pop().unwrap();
        replaced.push(if last == '0' { '1' } else { '0' });
        assert_eq!(own_user_pipe(&replaced, &sid), Ok(PathBuf::from(&replaced)));
        write_windows_control(dir.path(), &replaced);
        assert!(
            resolve_socket(dir.path()).is_err(),
            "a well-formed own-user pipe must still match the actual data directory"
        );
    }

    #[test]
    #[cfg(windows)]
    fn resolve_socket_accepts_junction_and_verbatim_aliases_of_the_same_home() {
        let parent = tempfile::tempdir().unwrap();
        let physical = parent.path().join("physical home café");
        let junction = parent.path().join("junction home café");
        std::fs::create_dir(&physical).unwrap();
        let scoped = expected_windows_pipe(&physical);
        write_windows_control(&physical, &scoped);
        let created = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&physical)
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "junction creation failed: {created:?}"
        );
        let verbatim = physical.canonicalize().unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
        for alias in [&junction, &verbatim] {
            assert_eq!(
                expected_windows_pipe(alias),
                scoped,
                "OS identity of {alias:?}"
            );
            assert_eq!(
                resolve_socket(alias),
                Ok(PathBuf::from(&scoped)),
                "{alias:?}"
            );
        }
        std::fs::remove_dir(&junction).unwrap();
    }

    #[test]
    fn discovery_requires_an_exact_data_directory_digest() {
        for digest in [
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "A".repeat(64),
            "g".repeat(64),
            format!("{ROOT_DIGEST}\\other"),
            format!("{ROOT_DIGEST} "),
        ] {
            let pipe = format!(r"\\.\pipe\backplane-companion-{OWN_SID}-{digest}");
            assert_eq!(
                own_user_pipe(&pipe, OWN_SID),
                Err(DiscoveryError::PipeNotOwnUser),
                "{pipe}"
            );
        }
    }

    #[test]
    fn discovery_rejects_other_sid_pipe() {
        for other in [
            "S-1-5-21-3623811015-3361044348-30300820-1014",
            "S-1-5-21-3623811015-3361044348-30300820-101",
            "S-1-5-18",
            "S-1-1-0",
        ] {
            let pipe = format!(r"\\.\pipe\backplane-companion-{other}-{ROOT_DIGEST}");
            assert_eq!(
                own_user_pipe(&pipe, OWN_SID),
                Err(DiscoveryError::PipeNotOwnUser),
                "{pipe}"
            );
        }
    }

    #[test]
    fn discovery_rejects_unc_or_file_path_pipe() {
        for socket in [
            format!(r"\\server\pipe\backplane-companion-{OWN_SID}"),
            format!(r"\\?\pipe\backplane-companion-{OWN_SID}"),
            format!(r"\\.\PIPE\backplane-companion-{OWN_SID}"),
            format!(r"//./pipe/backplane-companion-{OWN_SID}"),
            format!(r"\\.\pipe\backplane-companion-{OWN_SID}\..\other"),
            format!(r"\\.\pipe\backplane-companion-{OWN_SID}-x"),
            format!(r"\\.\pipe\backplane-companion-{OWN_SID} "),
            format!(r"\\.\pipe\other-{OWN_SID}"),
            r"C:\home\me\AppData\Local\Backplane\Companion\control.sock".to_string(),
            "/tmp/control.sock".to_string(),
            String::new(),
        ] {
            assert_eq!(
                own_user_pipe(&socket, OWN_SID),
                Err(DiscoveryError::PipeNotOwnUser),
                "{socket}"
            );
        }
    }

    #[test]
    fn discovery_refuses_when_the_own_sid_is_not_a_sid() {
        for own_sid in [
            "",
            "S-1",
            "S-1-5-21-1)(A;;GA;;;WD",
            "s-1-5-18",
            "S-1-5-21-1\\..\\x",
        ] {
            let pipe = format!(r"\\.\pipe\backplane-companion-{own_sid}");
            assert_eq!(
                own_user_pipe(&pipe, own_sid),
                Err(DiscoveryError::UserUnknown),
                "{own_sid:?}"
            );
        }
    }

    #[test]
    fn home_dir_on_windows_uses_userprofile_like_go() {
        assert_eq!(
            home_dir(env(&[("USERPROFILE", r"C:\home\me")]), "windows"),
            Some(PathBuf::from(r"C:\home\me"))
        );
    }

    #[test]
    fn home_dir_on_windows_without_userprofile_is_unknown_even_with_home_set() {
        assert_eq!(home_dir(env(&[("HOME", "/c/home/me")]), "windows"), None);
        assert_eq!(home_dir(env(&[("USERPROFILE", "")]), "windows"), None);
    }

    #[test]
    fn home_dir_elsewhere_uses_home() {
        for os in ["macos", "linux"] {
            assert_eq!(
                home_dir(env(&[("HOME", HOME), ("USERPROFILE", "/nope")]), os),
                Some(PathBuf::from(HOME)),
                "{os}"
            );
            assert_eq!(home_dir(env(&[("HOME", "")]), os), None, "{os}");
        }
    }

    #[test]
    fn reason_code_is_stable_snake_case() {
        assert_eq!(
            DiscoveryError::ControlFileMissing.reason_code(),
            "control_file_missing"
        );
        assert_eq!(DiscoveryError::HomeUnknown.reason_code(), "home_unknown");
        assert_eq!(
            DiscoveryError::PipeNotOwnUser.reason_code(),
            "pipe_not_own_user"
        );
        assert_eq!(DiscoveryError::UserUnknown.reason_code(), "user_unknown");
    }
}
