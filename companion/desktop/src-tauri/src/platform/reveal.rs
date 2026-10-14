// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Showing a file in the platform's file manager. Always an argument list,
//! never a shell.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::install::windows_segments;
use super::PlatformOs;
use crate::native::agent_config::Revealer;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevealCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub exit_status_reports_failure: bool,
}

/// None where this build has no way to reveal a file yet, or for a relative
/// path, which a file manager could read as an option.
pub fn reveal_command(os: PlatformOs, path: &Path) -> Option<RevealCommand> {
    if !path.is_absolute() {
        return None;
    }
    match os {
        // `open -R` selects the file in a Finder window.
        PlatformOs::Macos => Some(RevealCommand {
            program: PathBuf::from("/usr/bin/open"),
            args: vec!["-R".into(), path.as_os_str().to_owned()],
            exit_status_reports_failure: true,
        }),
        // File managers disagree on selecting a file, so the folder is opened.
        PlatformOs::Linux => Some(RevealCommand {
            program: PathBuf::from("/usr/bin/xdg-open"),
            args: vec![path.parent()?.as_os_str().to_owned()],
            exit_status_reports_failure: true,
        }),
        PlatformOs::Windows => {
            windows_reveal_command(path.to_str()?, std::env::var("SystemRoot").ok().as_deref())
        }
        PlatformOs::Unknown => None,
    }
}

/// `explorer.exe /select,` from the system root, for a local drive path only:
/// a UNC path would make Explorer contact that server with the user's
/// credentials, and `..` or a relative path could land on something else.
pub fn windows_reveal_command(path: &str, system_root: Option<&str>) -> Option<RevealCommand> {
    let system_root = system_root.filter(|root| windows_segments(root).is_some())?;
    windows_segments(path)?;
    Some(RevealCommand {
        program: PathBuf::from(format!(r"{system_root}\explorer.exe")),
        // Two arguments, so a path with spaces or commas is never spliced
        // into the `/select,` switch.
        args: vec!["/select,".into(), path.into()],
        // explorer.exe exits 1 even after it opened the window.
        exit_status_reports_failure: false,
    })
}

pub struct SystemRevealer {
    os: PlatformOs,
}

impl SystemRevealer {
    pub fn for_os(os: PlatformOs) -> Self {
        Self { os }
    }

    pub fn current() -> Self {
        Self::for_os(PlatformOs::current())
    }
}

impl Revealer for SystemRevealer {
    fn reveal(&self, path: &Path) -> std::io::Result<()> {
        let command = reveal_command(self.os, path).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "revealing a file is not supported here",
            )
        })?;
        let status = std::process::Command::new(&command.program)
            .args(&command.args)
            .status()?;
        if status.success() || !command.exit_status_reports_failure {
            Ok(())
        } else {
            Err(std::io::Error::other(format!(
                "{} exited with {status}",
                command.program.display()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "/home/me/.claude/settings.json";

    #[test]
    fn reveal_on_macos_selects_the_file_in_finder_without_a_shell() {
        let command = reveal_command(PlatformOs::Macos, Path::new(CONFIG)).unwrap();
        assert_eq!(command.program, Path::new("/usr/bin/open"));
        assert_eq!(command.args, [OsString::from("-R"), OsString::from(CONFIG)]);
    }

    const WINDOWS_CONFIG: &str = r"C:\home\me\.claude\settings.json";

    #[test]
    fn reveal_on_windows_selects_the_file_in_explorer_with_an_argument_list() {
        let command = windows_reveal_command(WINDOWS_CONFIG, Some(r"C:\Windows")).unwrap();
        assert_eq!(command.program, PathBuf::from(r"C:\Windows\explorer.exe"));
        // Two arguments: explorer takes `/select,` and the path apart, so a
        // path with spaces or commas never needs quoting into one argument.
        assert_eq!(
            command.args,
            [OsString::from("/select,"), OsString::from(WINDOWS_CONFIG)]
        );
    }

    #[test]
    fn reveal_on_windows_ignores_explorers_exit_code() {
        // explorer.exe exits 1 even after it opened the window.
        let command = windows_reveal_command(WINDOWS_CONFIG, Some(r"C:\Windows")).unwrap();
        assert!(!command.exit_status_reports_failure);
        let macos = reveal_command(PlatformOs::Macos, Path::new(CONFIG)).unwrap();
        assert!(macos.exit_status_reports_failure);
    }

    #[test]
    fn reveal_on_windows_accepts_the_verbatim_form_and_forward_slashes() {
        for path in [
            r"\\?\C:\home\me\.codex\config.toml",
            "D:/work/.pi/settings.json",
        ] {
            assert!(
                windows_reveal_command(path, Some(r"C:\Windows")).is_some(),
                "{path}"
            );
        }
    }

    #[test]
    fn reveal_on_windows_refuses_unc_relative_and_option_like_paths() {
        // A UNC path would make Explorer contact that server with the
        // user's credentials.
        for path in [
            r"\\attacker\share\settings.json",
            r"\\?\UNC\attacker\share\settings.json",
            r"\\.\C:\home\me\settings.json",
            r"C:settings.json",
            r"Users\me\settings.json",
            "/select,C:\\Windows",
            "-a",
            r"C:\home\me\..\..\Windows\win.ini",
            "",
        ] {
            assert_eq!(
                windows_reveal_command(path, Some(r"C:\Windows")),
                None,
                "{path}"
            );
        }
    }

    #[test]
    fn reveal_on_windows_without_a_trustworthy_system_root_has_no_command() {
        for system_root in [None, Some(""), Some("Windows"), Some(r"\\evil\share")] {
            assert_eq!(
                windows_reveal_command(WINDOWS_CONFIG, system_root),
                None,
                "{system_root:?}"
            );
        }
    }

    #[test]
    fn reveal_on_linux_opens_the_containing_folder_with_xdg_open() {
        let command =
            reveal_command(PlatformOs::Linux, Path::new("/home/me/.codex/config.toml")).unwrap();
        assert_eq!(command.program, Path::new("/usr/bin/xdg-open"));
        assert_eq!(command.args, [OsString::from("/home/me/.codex")]);
    }

    #[test]
    fn reveal_on_linux_passes_an_odd_folder_as_one_argument() {
        let command = reveal_command(
            PlatformOs::Linux,
            Path::new("/home/me/My Stuff; rm -rf ~/$(x)/settings.json"),
        )
        .unwrap();
        assert_eq!(
            command.args,
            [OsString::from("/home/me/My Stuff; rm -rf ~/$(x)")]
        );
    }

    #[test]
    fn reveal_on_linux_refuses_the_root_and_relative_paths() {
        for path in ["/", "settings.json", "-a", ""] {
            assert_eq!(
                reveal_command(PlatformOs::Linux, Path::new(path)),
                None,
                "{path}"
            );
        }
    }

    #[test]
    fn reveal_on_an_unknown_os_has_no_command() {
        assert_eq!(reveal_command(PlatformOs::Unknown, Path::new(CONFIG)), None);
    }

    #[test]
    fn reveal_refuses_a_relative_path_that_could_read_as_an_option() {
        for path in ["-a", "settings.json", ""] {
            assert_eq!(
                reveal_command(PlatformOs::Macos, Path::new(path)),
                None,
                "{path}"
            );
        }
    }

    #[test]
    fn system_revealer_without_a_command_reports_unsupported() {
        let error = SystemRevealer::for_os(PlatformOs::Unknown)
            .reveal(Path::new(CONFIG))
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Unsupported);
    }
}
