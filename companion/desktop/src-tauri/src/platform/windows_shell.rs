// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! What the Windows shell reads from the registry: the OS build (Mica needs
//! Windows 11) and whether the taskbar is light or dark.

/// `CurrentBuildNumber` is a plain decimal string; anything else is unknown.
pub fn windows_build_number(current_build_number: &str) -> Option<u32> {
    if current_build_number.is_empty()
        || !current_build_number
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    current_build_number.parse().ok()
}

/// `SystemUsesLightTheme` is the taskbar's theme, which can differ from the
/// apps' theme (`AppsUseLightTheme`) that the webview follows.
pub fn taskbar_is_light(system_uses_light_theme: Option<u32>) -> Option<bool> {
    match system_uses_light_theme? {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

#[cfg(windows)]
pub use registry::{current_build, current_taskbar_is_light, watch_taskbar_theme};

#[cfg(windows)]
mod registry {
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegGetValueW, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_NOTIFY, REG_NOTIFY_CHANGE_LAST_SET, RRF_RT_REG_DWORD,
        RRF_RT_REG_SZ,
    };

    use super::{taskbar_is_light, windows_build_number};

    const CURRENT_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    const PERSONALIZE_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    /// A build number is five digits today; generous room, still bounded.
    const BUILD_NUMBER_MAX_UNITS: usize = 32;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn current_build() -> Option<u32> {
        let mut buffer = [0u16; BUILD_NUMBER_MAX_UNITS];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        let (key, value) = (wide(CURRENT_VERSION_KEY), wide("CurrentBuildNumber"));
        // SAFETY: the buffer and its byte size match; strings are NUL-terminated.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (size as usize / 2).min(buffer.len());
        let text = String::from_utf16(&buffer[..units]).ok()?;
        windows_build_number(text.trim_end_matches('\0'))
    }

    pub fn current_taskbar_is_light() -> Option<bool> {
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let (key, name) = (wide(PERSONALIZE_KEY), wide("SystemUsesLightTheme"));
        // SAFETY: `value` is a DWORD and `size` its byte size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        taskbar_is_light((status == ERROR_SUCCESS).then_some(value))
    }

    /// Calls `on_change` with the taskbar theme each time the Personalize key
    /// changes, on a thread of its own that blocks in the registry wait.
    pub fn watch_taskbar_theme(on_change: impl Fn(Option<bool>) + Send + 'static) {
        std::thread::spawn(move || {
            let mut key: HKEY = null_mut();
            let path = wide(PERSONALIZE_KEY);
            // SAFETY: `key` is written on success and closed when the loop ends.
            if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_NOTIFY, &mut key) }
                != ERROR_SUCCESS
            {
                log::warn!("taskbar theme changes will not update the tray icon");
                return;
            }
            loop {
                // SAFETY: a synchronous wait on an open key; no event handle.
                let status = unsafe {
                    RegNotifyChangeKeyValue(key, 0, REG_NOTIFY_CHANGE_LAST_SET, null_mut(), 0)
                };
                if status != ERROR_SUCCESS {
                    break;
                }
                on_change(current_taskbar_is_light());
            }
            // SAFETY: opened above and not used after this.
            unsafe { RegCloseKey(key) };
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_build_number_parses_the_registry_string() {
        assert_eq!(windows_build_number("19045"), Some(19045));
        assert_eq!(windows_build_number("22631"), Some(22631));
    }

    #[test]
    fn windows_build_number_rejects_anything_but_plain_digits() {
        for raw in [
            "",
            " 22631",
            "22631 ",
            "22631.4169",
            "-1",
            "+22631",
            "abc",
            "99999999999",
        ] {
            assert_eq!(windows_build_number(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn taskbar_is_light_reads_the_dword() {
        assert_eq!(taskbar_is_light(Some(1)), Some(true));
        assert_eq!(taskbar_is_light(Some(0)), Some(false));
    }

    #[test]
    fn taskbar_is_light_without_the_value_is_unknown() {
        assert_eq!(taskbar_is_light(None), None);
        assert_eq!(taskbar_is_light(Some(2)), None);
    }
}
