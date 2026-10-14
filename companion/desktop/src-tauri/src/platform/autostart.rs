// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Launch at login on Linux: an XDG autostart desktop entry. The autostart
//! plugin writes the executable path unquoted, so a folder with a space breaks
//! the entry, and an AppImage's own path is a mount that is gone at the next
//! login; this writer quotes per the Desktop Entry spec and launches the
//! `.AppImage` file instead.

use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};

use super::appimage::is_mount_component;
use crate::native::login_item::LoginItem;

/// Passed by the autostart entry so a login launch can stay in the tray.
pub const AUTOSTART_ARG: &str = "--autostart";

const ENTRY_DISPLAY_NAME: &str = "Backplane Companion";

pub fn launched_at_login(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter().skip(1).any(|arg| arg == AUTOSTART_ARG)
}

/// What the entry starts: the AppImage file for an AppImage run, the
/// executable otherwise.
pub fn autostart_launch_path(
    current_exe: &Path,
    appimage: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let durable = |path: &Path| {
        path.is_absolute()
            && !path
                .components()
                .any(|part| part == Component::ParentDir || is_mount_component(part))
    };
    if !current_exe.components().any(is_mount_component) {
        return if durable(current_exe) {
            Ok(current_exe.to_path_buf())
        } else {
            Err(format!("{} is not an absolute path", current_exe.display()))
        };
    }
    match appimage.map(Path::new) {
        Some(appimage) if durable(appimage) => Ok(appimage.to_path_buf()),
        _ => Err("the AppImage file could not be found (APPIMAGE is not set)".into()),
    }
}

/// Exec quoting per the Desktop Entry spec: the path is one double-quoted
/// argument, then the value is escaped as a string and `%` is not a field code.
pub fn desktop_entry(launch: &Path) -> Result<String, String> {
    let path = launch
        .to_str()
        .ok_or_else(|| format!("{} is not valid UTF-8", launch.display()))?;
    if path.chars().any(char::is_control) {
        return Err("the app path contains control characters".into());
    }
    let mut quoted = String::with_capacity(path.len() + 2);
    for character in path.chars() {
        if matches!(character, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    let exec = quoted.replace('\\', "\\\\").replace('%', "%%");
    Ok(format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Version=1.0\n\
         Name={ENTRY_DISPLAY_NAME}\n\
         Exec=\"{exec}\" {AUTOSTART_ARG}\n\
         StartupNotify=false\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n"
    ))
}

/// Named after the GUI binary, like its icon and StartupWMClass.
const AUTOSTART_FILE: &str = "backplane-companion-desktop.desktop";
/// What the autostart plugin named the entry: the bundle identifier plus
/// `.desktop`. Found and removed so an older install never starts the app twice.
const LEGACY_AUTOSTART_FILE: &str = "dev.backplane.companion.desktop.desktop";

pub struct LinuxAutostart {
    entry_file: PathBuf,
    legacy_file: PathBuf,
    launch: Result<PathBuf, String>,
}

impl LinuxAutostart {
    /// None when neither XDG_CONFIG_HOME nor HOME is an absolute path.
    pub fn from_environment(
        getenv: impl Fn(&str) -> Option<OsString>,
        current_exe: &Path,
    ) -> Option<Self> {
        let absolute = |name: &str| {
            getenv(name)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
        };
        let config_dir = absolute("XDG_CONFIG_HOME")
            .or_else(|| absolute("HOME").map(|home| home.join(".config")))?;
        let autostart_dir = config_dir.join("autostart");
        Some(Self {
            entry_file: autostart_dir.join(AUTOSTART_FILE),
            legacy_file: autostart_dir.join(LEGACY_AUTOSTART_FILE),
            launch: autostart_launch_path(current_exe, getenv("APPIMAGE").as_deref()),
        })
    }
}

impl LoginItem for LinuxAutostart {
    fn is_enabled(&self) -> Result<bool, String> {
        for file in [&self.entry_file, &self.legacy_file] {
            if file.try_exists().map_err(|error| error.to_string())? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn enable(&self) -> Result<(), String> {
        let entry = desktop_entry(self.launch.as_ref().map_err(Clone::clone)?)?;
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.entry_file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let staged = self.entry_file.with_extension("desktop.tmp");
            std::fs::write(&staged, entry)?;
            std::fs::rename(&staged, &self.entry_file)
        };
        write().map_err(|error| error.to_string())?;
        remove_if_present(&self.legacy_file)
    }

    fn disable(&self) -> Result<(), String> {
        remove_if_present(&self.entry_file)?;
        remove_if_present(&self.legacy_file)
    }
}

fn remove_if_present(file: &Path) -> Result<(), String> {
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const MOUNTED_EXE: &str = "/tmp/.mount_BackplZk3/usr/bin/backplane-companion-desktop";

    fn environment(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let variables: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| (name.to_string(), OsString::from(value)))
            .collect();
        move |name| variables.get(name).cloned()
    }

    fn exec_line(entry: &str) -> &str {
        entry
            .lines()
            .find(|line| line.starts_with("Exec="))
            .expect("an Exec line")
    }

    #[test]
    fn autostart_entry_uses_appimage_env_path() {
        let launch = autostart_launch_path(
            Path::new(MOUNTED_EXE),
            Some(OsStr::new("/home/me/Apps/Backplane_Companion.AppImage")),
        )
        .unwrap();
        assert_eq!(
            launch,
            Path::new("/home/me/Apps/Backplane_Companion.AppImage")
        );
        let entry = desktop_entry(&launch).unwrap();
        assert_eq!(
            exec_line(&entry),
            "Exec=\"/home/me/Apps/Backplane_Companion.AppImage\" --autostart"
        );
    }

    #[test]
    fn autostart_entry_uses_the_executable_outside_an_appimage() {
        let executable = "/usr/lib/backplane-companion/backplane-companion-desktop";
        assert_eq!(
            autostart_launch_path(Path::new(executable), None).unwrap(),
            Path::new(executable)
        );
    }

    #[test]
    fn autostart_never_launches_the_ephemeral_mount() {
        for appimage in [
            None,
            Some("Backplane_Companion.AppImage"),
            Some(""),
            Some("/tmp/.mount_other/Backplane_Companion.AppImage"),
            Some("/home/me/../tmp/Backplane_Companion.AppImage"),
        ] {
            assert!(
                autostart_launch_path(Path::new(MOUNTED_EXE), appimage.map(OsStr::new)).is_err(),
                "{appimage:?}"
            );
        }
    }

    #[test]
    fn autostart_refuses_a_relative_executable() {
        assert!(autostart_launch_path(Path::new("backplane-companion-desktop"), None).is_err());
    }

    #[test]
    fn desktop_entry_quotes_spaces_and_escapes_reserved_characters() {
        let entry = desktop_entry(Path::new("/home/me/My Apps/a\"b`c$d\\e%f.AppImage")).unwrap();
        assert_eq!(
            exec_line(&entry),
            r#"Exec="/home/me/My Apps/a\\"b\\`c\\$d\\\\e%%f.AppImage" --autostart"#
        );
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("\nType=Application\n"));
        assert!(entry.contains("\nName=Backplane Companion\n"));
    }

    /// How a launcher reads Exec, from the Desktop Entry spec: the value is
    /// unescaped as a string first (`\\` → `\`, `\s`, `\n`, `\t`, `\r`), then
    /// `%%` is a literal `%`, then the line splits into arguments where a
    /// double-quoted one takes `\"`, `\``, `\$` and `\\` as escapes. Returns
    /// None for a value the spec does not allow, as GLib rejects it.
    fn exec_argv(value: &str) -> Option<Vec<String>> {
        let mut unescaped = String::new();
        let mut characters = value.chars();
        while let Some(character) = characters.next() {
            if character != '\\' {
                unescaped.push(character);
                continue;
            }
            unescaped.push(match characters.next()? {
                '\\' => '\\',
                's' => ' ',
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                _ => return None,
            });
        }
        let unescaped = unescaped.replace("%%", "%");
        let mut argv = Vec::new();
        let mut characters = unescaped.chars().peekable();
        while let Some(&character) = characters.peek() {
            if character == ' ' {
                characters.next();
                continue;
            }
            let mut argument = String::new();
            if character == '"' {
                characters.next();
                loop {
                    match characters.next()? {
                        '"' => break,
                        '\\' => {
                            let escaped = characters.next()?;
                            if !matches!(escaped, '"' | '`' | '$' | '\\') {
                                return None;
                            }
                            argument.push(escaped);
                        }
                        other => argument.push(other),
                    }
                }
            } else {
                while let Some(&next) = characters.peek() {
                    if next == ' ' {
                        break;
                    }
                    argument.push(next);
                    characters.next();
                }
            }
            argv.push(argument);
        }
        Some(argv)
    }

    #[test]
    fn desktop_entry_exec_round_trips_through_the_spec_unescape() {
        for path in [
            "/home/me/Apps/Backplane_Companion.AppImage",
            "/home/me/My Apps/Backplane Companion.AppImage",
            "/home/me/a\"b`c$d\\e%f.AppImage",
            "/home/me/100% \\\\ \"$HOME\"/`id`.AppImage",
        ] {
            let entry = desktop_entry(Path::new(path)).unwrap();
            let value = exec_line(&entry).strip_prefix("Exec=").unwrap();
            assert_eq!(
                exec_argv(value),
                Some(vec![path.to_string(), AUTOSTART_ARG.to_string()]),
                "{value}"
            );
        }
    }

    #[test]
    fn exec_argv_rejects_the_single_escaped_form_glib_refuses() {
        // `\"` is not a string escape, so GLib's key-file reader refuses the
        // whole value (checked against libglib 2.72 in the Linux builder).
        assert_eq!(exec_argv(r#""/home/me/a\"b" --autostart"#), None);
    }

    #[test]
    fn desktop_entry_refuses_control_characters_that_would_split_the_entry() {
        for path in ["/home/me/a\nExec=evil", "/home/me/a\rb", "/home/me/a\tb"] {
            assert!(desktop_entry(Path::new(path)).is_err(), "{path:?}");
        }
    }

    #[test]
    fn launched_at_login_only_with_the_autostart_flag() {
        let args = |list: &[&str]| list.iter().map(OsString::from).collect::<Vec<_>>();
        assert!(launched_at_login(args(&["/usr/bin/app", "--autostart"])));
        assert!(!launched_at_login(args(&["/usr/bin/app"])));
        assert!(!launched_at_login(args(&[
            "/usr/bin/app",
            "--autostart=no"
        ])));
        // argv[0] is the program, never a flag.
        assert!(!launched_at_login(args(&["--autostart"])));
    }

    #[test]
    fn linux_autostart_follows_xdg_config_home_then_home() {
        let config = tempfile::tempdir().unwrap();
        let config_home = config.path().to_string_lossy().into_owned();
        let item = LinuxAutostart::from_environment(
            environment(&[("XDG_CONFIG_HOME", &config_home), ("HOME", "/home/me")]),
            Path::new("/usr/lib/backplane-companion/backplane-companion-desktop"),
        )
        .unwrap();
        assert_eq!(
            item.entry_file,
            config
                .path()
                .join("autostart/backplane-companion-desktop.desktop")
        );
        let item = LinuxAutostart::from_environment(
            environment(&[("XDG_CONFIG_HOME", "relative"), ("HOME", "/home/me")]),
            Path::new("/usr/lib/backplane-companion/backplane-companion-desktop"),
        )
        .unwrap();
        assert_eq!(
            item.entry_file,
            Path::new("/home/me/.config/autostart/backplane-companion-desktop.desktop")
        );
        assert!(LinuxAutostart::from_environment(
            environment(&[("HOME", "home/me")]),
            Path::new("/usr/lib/backplane-companion/backplane-companion-desktop"),
        )
        .is_none());
    }

    #[test]
    fn linux_autostart_enable_writes_the_entry_and_disable_removes_it() {
        let config = tempfile::tempdir().unwrap();
        let config_home = config.path().to_string_lossy().into_owned();
        let item = LinuxAutostart::from_environment(
            environment(&[
                ("XDG_CONFIG_HOME", &config_home),
                ("APPIMAGE", "/home/me/Backplane Companion.AppImage"),
            ]),
            Path::new(MOUNTED_EXE),
        )
        .unwrap();
        assert_eq!(item.is_enabled(), Ok(false));

        item.enable().unwrap();
        assert_eq!(item.is_enabled(), Ok(true));
        let written = std::fs::read_to_string(&item.entry_file).unwrap();
        assert_eq!(
            exec_line(&written),
            "Exec=\"/home/me/Backplane Companion.AppImage\" --autostart"
        );

        item.disable().unwrap();
        assert_eq!(item.is_enabled(), Ok(false));
        // Disabling twice is not an error.
        item.disable().unwrap();
    }

    #[test]
    fn linux_autostart_refuses_to_enable_a_mount_path_and_writes_nothing() {
        let config = tempfile::tempdir().unwrap();
        let config_home = config.path().to_string_lossy().into_owned();
        let item = LinuxAutostart::from_environment(
            environment(&[("XDG_CONFIG_HOME", &config_home)]),
            Path::new(MOUNTED_EXE),
        )
        .unwrap();
        assert!(item.enable().is_err());
        assert!(!item.entry_file.exists());
    }

    /// An autostart folder holding the old plugin-named entry, and the item for it.
    fn with_legacy_entry() -> (tempfile::TempDir, LinuxAutostart, PathBuf) {
        let config = tempfile::tempdir().unwrap();
        let config_home = config.path().to_string_lossy().into_owned();
        let autostart = config.path().join("autostart");
        std::fs::create_dir_all(&autostart).unwrap();
        let legacy = autostart.join("dev.backplane.companion.desktop.desktop");
        std::fs::write(&legacy, "[Desktop Entry]\nExec=/old --autostart\n").unwrap();
        let item = LinuxAutostart::from_environment(
            environment(&[("XDG_CONFIG_HOME", &config_home)]),
            Path::new("/usr/lib/backplane-companion/backplane-companion-desktop"),
        )
        .unwrap();
        (config, item, legacy)
    }

    #[test]
    fn linux_autostart_counts_a_legacy_entry_as_enabled() {
        let (_config, item, _legacy) = with_legacy_entry();
        assert_eq!(item.is_enabled(), Ok(true));
    }

    #[test]
    fn linux_autostart_enable_migrates_the_legacy_entry() {
        let (_config, item, legacy) = with_legacy_entry();
        item.enable().unwrap();
        assert!(!legacy.exists());
        assert!(item.entry_file.is_file());
        assert_eq!(item.is_enabled(), Ok(true));
    }

    #[test]
    fn linux_autostart_disable_removes_the_legacy_entry_too() {
        let (_config, item, legacy) = with_legacy_entry();
        item.disable().unwrap();
        assert!(!legacy.exists());
        assert_eq!(item.is_enabled(), Ok(false));
    }

    #[test]
    fn linux_autostart_leaves_other_apps_entries_alone() {
        let (config, item, _legacy) = with_legacy_entry();
        let other = config.path().join("autostart/org.example.Other.desktop");
        std::fs::write(&other, "[Desktop Entry]\n").unwrap();
        item.enable().unwrap();
        item.disable().unwrap();
        assert!(other.is_file());
    }

    #[test]
    fn linux_autostart_refused_enable_keeps_the_legacy_entry() {
        let (config, _item, legacy) = with_legacy_entry();
        let config_home = config.path().to_string_lossy().into_owned();
        let mounted = LinuxAutostart::from_environment(
            environment(&[("XDG_CONFIG_HOME", &config_home)]),
            Path::new(MOUNTED_EXE),
        )
        .unwrap();
        assert!(mounted.enable().is_err());
        // Nothing new was written, so the working old entry must survive.
        assert!(legacy.is_file());
    }
}
