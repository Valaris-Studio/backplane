// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! How a path is shown in the webview. Pure string work: it never touches the
//! filesystem, so a hostile path cannot make it stat, resolve or follow anything.

use std::sync::LazyLock;

use regex::Regex;

/// Control and format characters (bidi overrides, isolates, zero-width
/// joiners, BOM) plus line and paragraph separators: they can make a path
/// display as something it is not.
static INVISIBLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").expect("static pattern"));

fn is_separator(character: char) -> bool {
    character == '/' || character == '\\'
}

/// `path` with HOME shown as `~`; a path with a `..` segment shows only its
/// base name, since its prefix says nothing true about where it leads.
pub fn display_path(path: &str, home: Option<&str>, case_insensitive: bool) -> String {
    let visible = INVISIBLE.replace_all(path, "");
    let mut segments = visible.split(is_separator);
    if segments.clone().any(|segment| segment == "..") {
        let base_name = segments.rfind(|segment| !segment.is_empty()).unwrap_or("");
        return if base_name == ".." || base_name == "." {
            String::new()
        } else {
            base_name.to_string()
        };
    }
    let home = home.map(without_verbatim_prefix);
    match home.as_deref().and_then(usable_home) {
        Some(home) => {
            match strip_home(&without_verbatim_prefix(&visible), home, case_insensitive) {
                Some(rest) => format!("~{rest}"),
                None => visible.into_owned(),
            }
        }
        None => visible.into_owned(),
    }
}

const VERBATIM: &str = "\\\\?\\";
const VERBATIM_UNC: &str = "UNC\\";

/// `\\?\C:\…` as `C:\…` and `\\?\UNC\server\…` as `\\server\…`, the forms
/// `std::fs::canonicalize` returns on Windows; other verbatim forms
/// (`\\?\Volume{…}`) name no drive a HOME could be on and stay as they are.
fn without_verbatim_prefix(path: &str) -> std::borrow::Cow<'_, str> {
    let Some(rest) = path.strip_prefix(VERBATIM) else {
        return path.into();
    };
    // get(): a multibyte character may straddle the prefix's length.
    if let Some(prefix) = rest.get(..VERBATIM_UNC.len()) {
        if prefix.eq_ignore_ascii_case(VERBATIM_UNC) {
            return format!("\\\\{}", &rest[VERBATIM_UNC.len()..]).into();
        }
    }
    let mut chars = rest.chars();
    match (chars.next(), chars.next()) {
        (Some(drive), Some(':')) if drive.is_ascii_alphabetic() => rest.into(),
        _ => path.into(),
    }
}

/// An absolute HOME other than a root, without its trailing separators:
/// `/home/me`, `C:\home\me` (either separator) or `\\server\share\me`.
fn usable_home(home: &str) -> Option<&str> {
    let trimmed = home.trim_end_matches(is_separator);
    let mut chars = trimmed.chars();
    let windows_drive = matches!((chars.next(), chars.next(), chars.next()), (Some(drive), Some(':'), Some(separator)) if drive.is_ascii_alphabetic() && is_separator(separator));
    let unc = trimmed.starts_with("\\\\") && trimmed.len() > 2;
    let absolute = home.starts_with('/') || windows_drive || unc;
    (absolute && !trimmed.is_empty()).then_some(trimmed)
}

/// What follows HOME in `path`, when `path` is HOME or lies inside it.
fn strip_home<'a>(path: &'a str, home: &str, case_insensitive: bool) -> Option<&'a str> {
    let mut path_chars = path.char_indices();
    for home_char in home.chars() {
        let (_, path_char) = path_chars.next()?;
        let same = if is_separator(home_char) {
            is_separator(path_char)
        } else if case_insensitive {
            path_char.to_lowercase().eq(home_char.to_lowercase())
        } else {
            path_char == home_char
        };
        if !same {
            return None;
        }
    }
    let rest = path_chars.next().map_or("", |(offset, _)| &path[offset..]);
    (rest.is_empty() || rest.starts_with(is_separator)).then_some(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/me";

    fn shown(path: &str) -> String {
        display_path(path, Some(HOME), false)
    }

    #[test]
    fn display_path_masks_the_home_folder_to_a_tilde() {
        assert_eq!(shown("/home/me/code/app"), "~/code/app");
        assert_eq!(shown("/home/me"), "~");
        assert_eq!(shown("/home/me/"), "~/");
    }

    #[test]
    fn display_path_accepts_a_home_with_a_trailing_slash() {
        assert_eq!(
            display_path("/home/me/code", Some("/home/me/"), false),
            "~/code"
        );
    }

    #[test]
    fn display_path_leaves_a_path_outside_home_alone() {
        assert_eq!(shown("/opt/work/app"), "/opt/work/app");
        assert_eq!(shown("/home/other/app"), "/home/other/app");
    }

    #[test]
    fn display_path_never_masks_a_sibling_that_only_shares_the_prefix() {
        assert_eq!(shown("/home/me2/app"), "/home/me2/app");
        assert_eq!(shown("/home/meeting"), "/home/meeting");
    }

    #[test]
    fn display_path_matches_home_case_insensitively_only_when_asked() {
        assert_eq!(display_path("/HOME/ME/app", Some(HOME), true), "~/app");
        assert_eq!(
            display_path("/HOME/ME/app", Some(HOME), false),
            "/HOME/ME/app"
        );
    }

    #[test]
    fn display_path_masks_nothing_without_a_usable_home() {
        assert_eq!(display_path("/home/me/app", None, false), "/home/me/app");
        assert_eq!(
            display_path("/home/me/app", Some(""), false),
            "/home/me/app"
        );
        assert_eq!(
            display_path("/home/me/app", Some("/"), false),
            "/home/me/app"
        );
        assert_eq!(
            display_path("/home/me/app", Some("relative/me"), false),
            "/home/me/app"
        );
    }

    #[test]
    fn display_path_strips_bidi_overrides_and_invisible_format_characters() {
        assert_eq!(shown("/home/me/code/\u{202E}gpj.exe"), "~/code/gpj.exe");
        assert_eq!(
            shown("/home/me/\u{2066}a\u{2069}/b\u{200B}c\u{FEFF}"),
            "~/a/bc"
        );
        assert_eq!(shown("/home/me/x\u{200F}y\u{061C}z"), "~/xyz");
    }

    #[test]
    fn display_path_strips_control_characters_and_line_breaks() {
        assert_eq!(
            shown("/home/me/a\nb\rc\td\u{0}e\u{1B}[31mf\u{7F}g\u{85}h"),
            "~/abcde[31mfgh"
        );
        assert_eq!(shown("/home/me/a\u{2028}b\u{2029}c"), "~/abc");
    }

    #[test]
    fn display_path_cannot_be_tricked_into_masking_by_a_control_character() {
        assert_eq!(shown("/home/me\u{200B}2/app"), "/home/me2/app");
    }

    #[test]
    fn display_path_shows_only_the_base_name_of_a_path_with_a_parent_segment() {
        assert_eq!(shown("/home/me/../other/secret"), "secret");
        assert_eq!(shown("/home/me/code/../app/"), "app");
        assert_eq!(shown("../../etc/passwd"), "passwd");
        assert_eq!(shown("C:\\home\\me\\..\\x\\file.txt"), "file.txt");
    }

    #[test]
    fn display_path_hides_a_parent_segment_disguised_by_invisible_characters() {
        assert_eq!(shown("/home/me/.\u{200B}./other/secret"), "secret");
        assert_eq!(shown("/home/me/.\u{202E}./x"), "x");
    }

    #[test]
    fn display_path_shows_nothing_when_the_base_name_itself_is_a_dot_segment() {
        assert_eq!(shown("/home/me/code/.."), "");
        assert_eq!(shown(".."), "");
    }

    #[test]
    fn display_path_keeps_dots_that_are_not_a_parent_segment() {
        assert_eq!(shown("/home/me/.codex/config.toml"), "~/.codex/config.toml");
        assert_eq!(shown("/home/me/a..b/c"), "~/a..b/c");
        assert_eq!(shown("/home/me/./code"), "~/./code");
    }

    #[test]
    fn display_path_passes_a_relative_or_empty_path_through_sanitized() {
        assert_eq!(shown("code/app"), "code/app");
        assert_eq!(shown(""), "");
        assert_eq!(shown("~/already"), "~/already");
    }

    const WINDOWS_HOME: &str = "C:\\home\\ada";

    fn shown_on_windows(path: &str) -> String {
        display_path(path, Some(WINDOWS_HOME), true)
    }

    #[test]
    fn display_path_masks_a_windows_profile_folder_to_a_tilde() {
        assert_eq!(
            shown_on_windows("C:\\home\\ada\\.claude\\settings.json"),
            "~\\.claude\\settings.json"
        );
        assert_eq!(shown_on_windows("C:\\home\\ada"), "~");
    }

    #[test]
    fn display_path_matches_a_windows_profile_case_insensitively_with_either_separator() {
        assert_eq!(shown_on_windows("c:\\HOME\\ADA\\code"), "~\\code");
        assert_eq!(
            shown_on_windows("C:/home/ada/.codex/hooks.json"),
            "~/.codex/hooks.json"
        );
        assert_eq!(
            display_path("C:\\home\\ada\\code", Some("C:/home/ada/"), true),
            "~\\code"
        );
    }

    #[test]
    fn display_path_never_masks_a_windows_sibling_or_another_drive() {
        assert_eq!(shown_on_windows("C:\\home\\ada2\\x"), "C:\\home\\ada2\\x");
        assert_eq!(shown_on_windows("D:\\home\\ada\\x"), "D:\\home\\ada\\x");
        assert_eq!(
            shown_on_windows("C:\\home\\Public\\x"),
            "C:\\home\\Public\\x"
        );
    }

    #[test]
    fn display_path_refuses_a_bare_drive_or_relative_windows_home() {
        for home in ["C:\\", "C:", "C:/", "Users\\ada", "\\"] {
            assert_eq!(
                display_path("C:\\home\\ada\\x", Some(home), true),
                "C:\\home\\ada\\x",
                "home={home:?}"
            );
        }
    }

    #[test]
    fn display_path_masks_a_unc_profile_folder() {
        assert_eq!(
            display_path(
                "\\\\server\\home\\ada\\code",
                Some("\\\\server\\home\\ada"),
                true
            ),
            "~\\code"
        );
    }

    #[test]
    fn display_path_masks_a_verbatim_windows_path_as_canonicalize_returns_it() {
        assert_eq!(
            shown_on_windows("\\\\?\\C:\\home\\ada\\.claude"),
            "~\\.claude"
        );
        assert_eq!(
            display_path("C:\\home\\ada\\.claude", Some("\\\\?\\C:\\home\\ada"), true),
            "~\\.claude"
        );
    }

    #[test]
    fn display_path_masks_a_verbatim_unc_path_under_a_unc_home() {
        let home = Some("\\\\srv\\share\\home");
        assert_eq!(
            display_path("\\\\?\\UNC\\srv\\share\\home\\x", home, true),
            "~\\x"
        );
        assert_eq!(
            display_path("\\\\?\\unc\\srv\\share\\home\\x", home, true),
            "~\\x"
        );
    }

    #[test]
    fn display_path_never_masks_a_verbatim_sibling_another_drive_or_a_volume_path() {
        for path in [
            "\\\\?\\C:\\home\\ada2\\x",
            "\\\\?\\D:\\home\\ada\\x",
            "\\\\?\\Volume{0b1c2d3e}\\home\\ada\\x",
            "\\\\?\\ééé\\x",
        ] {
            assert_eq!(shown_on_windows(path), path);
        }
    }

    #[test]
    fn display_path_never_reads_the_filesystem() {
        let missing = "/home/me/does-not-exist-\u{1F600}/deeper";
        assert_eq!(shown(missing), "~/does-not-exist-\u{1F600}/deeper");
    }
}
