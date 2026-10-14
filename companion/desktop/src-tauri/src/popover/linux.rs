// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Linux: the app is a normal decorated window, not a popover. StatusNotifier
//! hosts can't anchor anything to the icon, so it opens centred in the work
//! area, or where the user last left it, at the size they last gave it. It
//! stays up when it loses focus.
//!
//! On X11 the first placement waits until the window is on screen: only then
//! does it know its frame, and GNOME would otherwise place it by its own rules.
//! On Wayland no client can position its window; the compositor does (GNOME
//! centres new windows only with org.gnome.mutter center-new-windows on), so
//! there only the size is fitted to the work area.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewWindow, WindowEvent};

use super::POPOVER_LABEL;

pub const WINDOW_STATE_FILE: &str = "window-state.json";
const MAX_WINDOW_STATE_BYTES: usize = 4096;
const MIN_WIDTH: u32 = 360;
const MIN_HEIGHT: u32 = 480;
/// The saved position counts only when this point near the top-left corner
/// (on the title bar) is on a monitor, so the window can always be dragged back.
const TITLE_BAR_GRIP: (i64, i64) = (32, 16);

/// The window's last outer position and inner size, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    /// None where the compositor never says (Wayland).
    pub position: Option<(i32, i32)>,
    pub width: u32,
    pub height: u32,
}

/// A monitor's bounds in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl MonitorArea {
    fn contains(&self, (x, y): (i64, i64)) -> bool {
        let (left, top) = (i64::from(self.x), i64::from(self.y));
        (left..left + i64::from(self.width)).contains(&x)
            && (top..top + i64::from(self.height)).contains(&y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Restore {
    /// None keeps the configured default size.
    pub size: Option<(u32, u32)>,
    /// None centres the window.
    pub position: Option<(i32, i32)>,
}

pub fn restore_geometry(saved: Option<WindowState>, monitors: &[MonitorArea]) -> Restore {
    let Some(saved) = saved else {
        return Restore {
            size: None,
            position: None,
        };
    };
    let widest = monitors.iter().map(|monitor| monitor.width).max();
    let tallest = monitors.iter().map(|monitor| monitor.height).max();
    let width = saved.width.max(MIN_WIDTH).min(widest.unwrap_or(u32::MAX));
    let height = saved
        .height
        .max(MIN_HEIGHT)
        .min(tallest.unwrap_or(u32::MAX));
    let position = saved.position.filter(|&(x, y)| {
        let grip = (
            i64::from(x) + TITLE_BAR_GRIP.0,
            i64::from(y) + TITLE_BAR_GRIP.1,
        );
        monitors.iter().any(|monitor| monitor.contains(grip))
    });
    Restore {
        size: Some((width, height)),
        position,
    }
}

/// The outer-frame position that centres a window in the work area (the
/// monitor minus panels and docks) and keeps all of it inside.
pub fn centred_in(work_area: MonitorArea, outer: (u32, u32)) -> (i32, i32) {
    let centre = |origin: i32, span: u32, size: u32| {
        let slack = i64::from(span.saturating_sub(size)) / 2;
        i32::try_from(i64::from(origin) + slack).unwrap_or(origin)
    };
    (
        centre(work_area.x, work_area.width, outer.0),
        centre(work_area.y, work_area.height, outer.1),
    )
}

/// A smaller inner size when the window plus its frame would not fit the
/// work area; None when it already fits.
pub fn inner_size_fitting(
    work_area: MonitorArea,
    inner: (u32, u32),
    outer: (u32, u32),
) -> Option<(u32, u32)> {
    let fit = |inner: u32, outer: u32, span: u32, minimum: u32| {
        let frame = outer.saturating_sub(inner);
        inner.min(span.saturating_sub(frame)).max(minimum)
    };
    let fitted = (
        fit(inner.0, outer.0, work_area.width, MIN_WIDTH),
        fit(inner.1, outer.1, work_area.height, MIN_HEIGHT),
    );
    (fitted != inner).then_some(fitted)
}

pub fn parse_window_state(raw: &[u8]) -> Option<WindowState> {
    if raw.len() > MAX_WINDOW_STATE_BYTES {
        return None;
    }
    serde_json::from_slice(raw).ok()
}

/// The geometry to save, kept current from move and resize events and written
/// when the window hides or closes rather than on every pixel of a drag.
struct RememberedWindow {
    file: Option<PathBuf>,
    state: Mutex<Option<WindowState>>,
}

impl RememberedWindow {
    fn update(&self, change: impl FnOnce(&mut WindowState)) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(state) = state.as_mut() {
            change(state);
        }
    }

    fn save(&self) {
        let (Some(file), Some(state)) = (
            self.file.as_ref(),
            *self.state.lock().unwrap_or_else(PoisonError::into_inner),
        ) else {
            return;
        };
        if let Err(error) = write_window_state(file, &state) {
            log::warn!("the window size was not saved: {error}");
        }
    }
}

fn write_window_state(file: &Path, state: &WindowState) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let staged = file.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec(state)?)?;
    std::fs::rename(&staged, file)
}

fn work_area_of(monitor: &tauri::Monitor) -> MonitorArea {
    let work_area = monitor.work_area();
    MonitorArea {
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
    }
}

fn monitor_areas(window: &WebviewWindow) -> Vec<MonitorArea> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(work_area_of)
        .collect()
}

/// First placement without a saved position: centred when first shown, then
/// once more on the first move or resize after that, when the window manager
/// has framed the window and its outer size includes the frame.
static FIRST_PLACEMENT: AtomicU8 = AtomicU8::new(PLACED);
const PLACED: u8 = 0;
const CENTRE_ON_SHOW: u8 = 1;
const CENTRE_ONCE_FRAMED: u8 = 2;

fn centre_in_work_area(window: &WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(inner), Ok(outer)) = (monitor, window.inner_size(), window.outer_size())
    else {
        return;
    };
    let work_area = work_area_of(&monitor);
    let inner = (inner.width, inner.height);
    let mut outer = (outer.width, outer.height);
    if let Some(fitted) = inner_size_fitting(work_area, inner, outer) {
        let _ = window.set_size(PhysicalSize::new(fitted.0, fitted.1));
        outer = (
            outer.0.saturating_sub(inner.0) + fitted.0,
            outer.1.saturating_sub(inner.1) + fitted.1,
        );
    }
    let (x, y) = centred_in(work_area, outer);
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Restores the saved geometry and wires closing: with a tray icon, closing
/// only hides the window (the tray brings it back); without one it quits.
pub fn install(app: &AppHandle, close_quits: Arc<AtomicBool>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return Ok(());
    };
    let file = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(WINDOW_STATE_FILE));
    let saved = file
        .as_ref()
        .and_then(|file| std::fs::read(file).ok())
        .and_then(|raw| parse_window_state(&raw));
    let restore = restore_geometry(saved, &monitor_areas(&window));
    if let Some((width, height)) = restore.size {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
    match restore.position {
        Some((x, y)) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        None => FIRST_PLACEMENT.store(CENTRE_ON_SHOW, Ordering::SeqCst),
    }

    let initial = window.inner_size().ok().map(|size| WindowState {
        position: window
            .outer_position()
            .ok()
            .map(|position| (position.x, position.y))
            .filter(|_| restore.position.is_some()),
        width: size.width,
        height: size.height,
    });
    let remembered = Arc::new(RememberedWindow {
        file,
        state: Mutex::new(initial),
    });
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(position) => {
            centre_once_framed(&handle);
            remembered.update(|state| state.position = Some((position.x, position.y)));
        }
        WindowEvent::Resized(size) if size.width > 0 && size.height > 0 => {
            centre_once_framed(&handle);
            remembered.update(|state| {
                state.width = size.width;
                state.height = size.height;
            });
        }
        WindowEvent::Focused(false) => remembered.save(),
        WindowEvent::CloseRequested { api, .. } => {
            remembered.save();
            if close_quits.load(Ordering::SeqCst) {
                handle.app_handle().exit(0);
            } else {
                api.prevent_close();
                let _ = handle.hide();
            }
        }
        _ => {}
    });
    Ok(())
}

/// Brings the window forward; the menu's "Open" and a second launch both mean
/// "show me", never "hide".
pub fn toggle(app: &AppHandle, _anchor: Option<Rect>) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        if FIRST_PLACEMENT
            .compare_exchange(
                CENTRE_ON_SHOW,
                CENTRE_ONCE_FRAMED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            centre_in_work_area(&window);
        }
        let _ = window.set_focus();
    }
}

fn centre_once_framed(window: &WebviewWindow) {
    if FIRST_PLACEMENT
        .compare_exchange(
            CENTRE_ONCE_FRAMED,
            PLACED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
    {
        centre_in_work_area(window);
    }
}

pub fn activate_for_dialog(_app: &AppHandle) {}

pub fn refocus_after_dialog(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_focus();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: MonitorArea = MonitorArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    const EXTERNAL_ON_THE_LEFT: MonitorArea = MonitorArea {
        x: -2560,
        y: 0,
        width: 2560,
        height: 1440,
    };

    fn state(x: i32, y: i32, width: u32, height: u32) -> WindowState {
        WindowState {
            position: Some((x, y)),
            width,
            height,
        }
    }

    /// Ubuntu 24.04 on Xorg: a 27 px top bar, and mutter's frame (with its
    /// shadow) adds 28 px across and 66 px down.
    const GNOME_WORK_AREA: MonitorArea = MonitorArea {
        x: 0,
        y: 27,
        width: 1920,
        height: 1053,
    };

    #[test]
    fn first_launch_centres_the_frame_in_the_work_area() {
        assert_eq!(centred_in(GNOME_WORK_AREA, (448, 706)), (736, 200));
    }

    #[test]
    fn first_launch_centres_on_a_monitor_right_of_the_primary() {
        let second = MonitorArea {
            x: 1920,
            y: 0,
            width: 2560,
            height: 1400,
        };
        assert_eq!(centred_in(second, (448, 706)), (1920 + 1056, 347));
    }

    #[test]
    fn first_launch_never_places_the_frame_past_the_work_area() {
        let small = MonitorArea {
            x: 0,
            y: 27,
            width: 1024,
            height: 573,
        };
        assert_eq!(centred_in(small, (1200, 706)), (0, 27));
        assert_eq!(centred_in(small, (448, 706)), (288, 27));
    }

    #[test]
    fn first_launch_shrinks_a_window_taller_than_the_work_area() {
        let short = MonitorArea {
            x: 0,
            y: 27,
            width: 1280,
            height: 573,
        };
        // 66 px of frame: the inner height that fits is 573 - 66.
        assert_eq!(
            inner_size_fitting(short, (420, 640), (448, 706)),
            Some((420, 507))
        );
    }

    #[test]
    fn first_launch_keeps_a_window_that_fits() {
        assert_eq!(
            inner_size_fitting(GNOME_WORK_AREA, (420, 640), (448, 706)),
            None
        );
    }

    #[test]
    fn first_launch_never_shrinks_below_the_minimum_size() {
        let tiny = MonitorArea {
            x: 0,
            y: 0,
            width: 300,
            height: 400,
        };
        assert_eq!(
            inner_size_fitting(tiny, (420, 640), (448, 706)),
            Some((360, 480))
        );
    }

    #[test]
    fn first_launch_treats_a_frame_smaller_than_the_client_as_no_frame() {
        // Before the window manager reparents it, a window reports its client
        // size as its outer size (or less).
        let short = MonitorArea {
            x: 0,
            y: 0,
            width: 1280,
            height: 600,
        };
        assert_eq!(
            inner_size_fitting(short, (420, 640), (400, 600)),
            Some((420, 600))
        );
    }

    #[test]
    fn window_state_round_trips() {
        let saved = state(200, 150, 480, 720);
        let raw = serde_json::to_vec(&saved).unwrap();
        assert_eq!(parse_window_state(&raw), Some(saved));
        assert_eq!(
            restore_geometry(Some(saved), &[LAPTOP]),
            Restore {
                size: Some((480, 720)),
                position: Some((200, 150)),
            }
        );
    }

    #[test]
    fn window_state_restores_onto_a_monitor_left_of_the_primary() {
        assert_eq!(
            restore_geometry(
                Some(state(-2000, 100, 480, 720)),
                &[LAPTOP, EXTERNAL_ON_THE_LEFT]
            )
            .position,
            Some((-2000, 100))
        );
    }

    #[test]
    fn window_state_ignores_offscreen_coordinates() {
        for saved in [
            state(5000, 100, 480, 720),
            state(-2000, 100, 480, 720),
            state(100, -500, 480, 720),
            state(100, 1075, 480, 720),
            state(1915, 100, 480, 720),
            state(i32::MAX, i32::MAX, 480, 720),
            state(i32::MIN, i32::MIN, 480, 720),
        ] {
            let restore = restore_geometry(Some(saved), &[LAPTOP]);
            assert_eq!(restore.position, None, "{saved:?}");
            assert_eq!(restore.size, Some((480, 720)), "{saved:?}");
        }
    }

    #[test]
    fn window_state_without_monitors_centres() {
        assert_eq!(
            restore_geometry(Some(state(200, 150, 480, 720)), &[]).position,
            None
        );
    }

    #[test]
    fn window_state_without_a_position_restores_only_the_size() {
        // Wayland never reports where a window is.
        let saved = WindowState {
            position: None,
            width: 480,
            height: 720,
        };
        let raw = serde_json::to_vec(&saved).unwrap();
        assert_eq!(parse_window_state(&raw), Some(saved));
        assert_eq!(
            restore_geometry(Some(saved), &[LAPTOP]),
            Restore {
                size: Some((480, 720)),
                position: None,
            }
        );
    }

    #[test]
    fn window_state_clamps_a_size_that_no_longer_fits() {
        let restore = restore_geometry(Some(state(0, 0, 9000, 9000)), &[LAPTOP]);
        assert_eq!(restore.size, Some((1920, 1080)));
        let restore = restore_geometry(Some(state(0, 0, 10, 10)), &[LAPTOP]);
        assert_eq!(restore.size, Some((360, 480)));
    }

    #[test]
    fn window_state_missing_keeps_the_default_size_and_centres() {
        assert_eq!(
            restore_geometry(None, &[LAPTOP]),
            Restore {
                size: None,
                position: None,
            }
        );
    }

    #[test]
    fn window_state_refuses_garbage_and_oversized_files() {
        assert_eq!(parse_window_state(b"not json"), None);
        assert_eq!(parse_window_state(br#"{"position":[1,2]}"#), None);
        assert_eq!(
            parse_window_state(br#"{"position":[1,2],"width":-5,"height":3}"#),
            None
        );
        let mut oversized = serde_json::to_vec(&state(1, 2, 480, 720)).unwrap();
        oversized.extend(std::iter::repeat_n(b' ', 8192));
        assert_eq!(parse_window_state(&oversized), None);
    }
}
