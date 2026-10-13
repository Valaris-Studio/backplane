// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Windows popover: an undecorated flyout over the notification area, kept
//! inside the monitor's work area whichever edge the taskbar is on, and
//! hidden when it loses focus. Its header drags it (the system move loop keeps
//! focus, and a blur hides only once another window is in front), and it reopens where it was dragged
//! to for the rest of the run. Linux borrows it until it has its own window.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, Rect, WebviewWindow, WindowEvent};

use super::reopen::{PopoverExtent, PopoverPlacement, PopoverWindow, ScreenRect};
use super::{place_for_reopen, POPOVER_LABEL};
use crate::native::dialog_focus::POPOVER_BLUR;

/// Windows 11 flyouts sit 12 px (at 100 %) off the taskbar and screen edges.
const GAP_PIXELS: f64 = 12.0;
const EDGE_MARGIN_PIXELS: f64 = 12.0;
/// Clicking the tray icon of an open popover blurs it before the click
/// arrives; a toggle this soon after a blur hide is that same click.
const BLUR_CLICK_GRACE: Duration = Duration::from_millis(400);
/// Long enough for an activation or a drag's focus shuffle to settle, short
/// enough that clicking away still feels immediate.
const BLUR_RECHECK_DELAY: Duration = Duration::from_millis(150);
/// Windows 11's first build; Mica does not exist before it.
const FIRST_WINDOWS_11_BUILD: u32 = 22000;

static LAST_BLUR_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskbarEdge {
    Bottom,
    Top,
    Left,
    Right,
}

/// The side of the work area the tray icon sits on. An auto-hidden taskbar
/// overlaps the work area, so an icon inside it counts for the nearest edge.
fn taskbar_edge(tray_icon: ScreenRect, work_area: ScreenRect) -> TaskbarEdge {
    let right = work_area.x + work_area.width;
    let bottom = work_area.y + work_area.height;
    if tray_icon.y >= bottom {
        return TaskbarEdge::Bottom;
    }
    if tray_icon.y + tray_icon.height <= work_area.y {
        return TaskbarEdge::Top;
    }
    if tray_icon.x + tray_icon.width <= work_area.x {
        return TaskbarEdge::Left;
    }
    if tray_icon.x >= right {
        return TaskbarEdge::Right;
    }
    let centre_x = tray_icon.x + tray_icon.width / 2.0;
    let centre_y = tray_icon.y + tray_icon.height / 2.0;
    [
        (bottom - centre_y, TaskbarEdge::Bottom),
        (centre_y - work_area.y, TaskbarEdge::Top),
        (centre_x - work_area.x, TaskbarEdge::Left),
        (right - centre_x, TaskbarEdge::Right),
    ]
    .into_iter()
    .min_by(|(a, _), (b, _)| a.total_cmp(b))
    .map_or(TaskbarEdge::Bottom, |(_, edge)| edge)
}

fn usable_tray_icon(tray_icon: Option<ScreenRect>) -> Option<ScreenRect> {
    tray_icon.filter(|icon| {
        [icon.x, icon.y, icon.width, icon.height]
            .iter()
            .all(|value| value.is_finite())
            && icon.width > 0.0
            && icon.height > 0.0
    })
}

fn clamp_into(value: f64, start: f64, length: f64, size: f64, margin: f64) -> f64 {
    let min = start + margin;
    let max = start + length - margin - size;
    if max < min {
        start
    } else {
        value.clamp(min, max)
    }
}

/// Positioner's `TrayBottomCenter` (centred on the icon), moved to the side
/// of the icon that faces the work area, then clamped into it. Without a
/// usable icon rect the flyout goes to the work area's bottom-right corner,
/// next to the default notification area.
pub fn flyout_origin(
    tray_icon: Option<ScreenRect>,
    popover_width: f64,
    popover_height: f64,
    work_area: ScreenRect,
    gap: f64,
    edge_margin: f64,
) -> PopoverPlacement {
    let right = work_area.x + work_area.width;
    let bottom = work_area.y + work_area.height;
    let (x, y) = match usable_tray_icon(tray_icon) {
        None => (right, bottom),
        Some(icon) => {
            let centred_x = icon.x + icon.width / 2.0 - popover_width / 2.0;
            let centred_y = icon.y + icon.height / 2.0 - popover_height / 2.0;
            match taskbar_edge(icon, work_area) {
                TaskbarEdge::Bottom => (centred_x, icon.y.min(bottom) - gap - popover_height),
                TaskbarEdge::Top => (centred_x, (icon.y + icon.height).max(work_area.y) + gap),
                TaskbarEdge::Left => ((icon.x + icon.width).max(work_area.x) + gap, centred_y),
                TaskbarEdge::Right => (icon.x.min(right) - gap - popover_width, centred_y),
            }
        }
    };
    PopoverPlacement {
        x: clamp_into(x, work_area.x, work_area.width, popover_width, edge_margin),
        y: clamp_into(
            y,
            work_area.y,
            work_area.height,
            popover_height,
            edge_margin,
        ),
    }
}

pub fn toggle_reopens(since_blur_hide: Option<Duration>) -> bool {
    since_blur_hide.is_none_or(|elapsed| elapsed >= BLUR_CLICK_GRACE)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backdrop {
    Mica,
    Acrylic,
    Solid,
}

/// What to try, in order. Windows 10 gets a solid background: its Acrylic
/// lags behind the window and Mica does not exist there.
pub fn backdrop_chain(windows_build: Option<u32>) -> &'static [Backdrop] {
    match windows_build {
        Some(build) if build >= FIRST_WINDOWS_11_BUILD => {
            &[Backdrop::Mica, Backdrop::Acrylic, Backdrop::Solid]
        }
        _ => &[Backdrop::Solid],
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return Ok(());
    };
    #[cfg(windows)]
    backdrop::apply(&window);
    let observed = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => on_blur(&observed, false),
        #[cfg(windows)]
        WindowEvent::ThemeChanged(_) => backdrop::apply(&observed),
        _ => {}
    });
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlurResponse {
    Hide,
    KeepOpen,
    /// Focus moved inside the popover (WebView2 child and frame trade it
    /// during a drag); look again once the system has settled.
    RecheckSoon,
}

/// Hide only once another window is in front: a blur while the popover is
/// still the foreground window is focus moving inside it.
pub fn blur_response(
    suppressed: bool,
    foreground_is_popover: bool,
    is_recheck: bool,
) -> BlurResponse {
    match (suppressed, foreground_is_popover, is_recheck) {
        (true, _, _) => BlurResponse::KeepOpen,
        (false, false, _) => BlurResponse::Hide,
        (false, true, false) => BlurResponse::RecheckSoon,
        (false, true, true) => BlurResponse::KeepOpen,
    }
}

fn on_blur(window: &WebviewWindow, is_recheck: bool) {
    match blur_response(
        POPOVER_BLUR.is_suppressed(),
        foreground_is(window),
        is_recheck,
    ) {
        BlurResponse::KeepOpen => {}
        BlurResponse::Hide => {
            if is_recheck && !window.is_visible().unwrap_or(false) {
                return;
            }
            let _ = window.hide();
            *lock_last_blur_hide() = Some(Instant::now());
        }
        BlurResponse::RecheckSoon => {
            let window = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(BLUR_RECHECK_DELAY);
                let on_main = window.clone();
                let _ = window.run_on_main_thread(move || on_blur(&on_main, true));
            });
        }
    }
}

/// Whether the foreground window is the popover (or a window inside it,
/// such as the WebView2 host).
#[cfg(windows)]
fn foreground_is(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT};
    let Ok(popover) = window.hwnd() else {
        return false;
    };
    // SAFETY: both calls only read window-manager state; a null or stale
    // handle yields null, which never matches the popover.
    let foreground_root = unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) };
    !foreground_root.is_null() && std::ptr::eq(foreground_root, popover.0)
}

#[cfg(not(windows))]
fn foreground_is(_window: &WebviewWindow) -> bool {
    false
}

fn lock_last_blur_hide() -> std::sync::MutexGuard<'static, Option<Instant>> {
    LAST_BLUR_HIDE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn toggle(app: &AppHandle, anchor: Option<Rect>) {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let since_blur_hide = lock_last_blur_hide().take().map(|at| at.elapsed());
    if !toggle_reopens(since_blur_hide) {
        return;
    }
    let by_tray = origin_by_tray(app, &window, anchor);
    place_for_reopen(&WindowInPixels(&window), by_tray);
    let _ = window.show();
    let _ = window.set_focus();
}

/// The flyout seen in virtual-screen pixels, which Windows keeps consistent
/// across displays of different scale.
struct WindowInPixels<'a>(&'a WebviewWindow);

impl PopoverWindow for WindowInPixels<'_> {
    fn origin(&self) -> Option<PopoverPlacement> {
        let origin = self.0.outer_position().ok()?;
        Some(PopoverPlacement {
            x: f64::from(origin.x),
            y: f64::from(origin.y),
        })
    }

    fn extent(&self) -> Option<PopoverExtent> {
        let size = self.0.outer_size().ok()?;
        Some(PopoverExtent {
            width: f64::from(size.width),
            height: f64::from(size.height),
            scale: self.0.scale_factor().unwrap_or(1.0),
        })
    }

    fn display_frames(&self) -> Vec<ScreenRect> {
        self.0
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|monitor| ScreenRect {
                x: f64::from(monitor.position().x),
                y: f64::from(monitor.position().y),
                width: f64::from(monitor.size().width),
                height: f64::from(monitor.size().height),
            })
            .collect()
    }

    fn move_to(&self, origin: PopoverPlacement) {
        let _ = self.0.set_position(PhysicalPosition::new(
            origin.x.round() as i32,
            origin.y.round() as i32,
        ));
    }

    fn fallback(&self) {
        let _ = self.0.center();
    }
}

fn origin_by_tray(
    app: &AppHandle,
    window: &WebviewWindow,
    anchor: Option<Rect>,
) -> Option<PopoverPlacement> {
    let fallback_scale = window.scale_factor().unwrap_or(1.0);
    let anchor_origin = anchor.map(|anchor| anchor.position.to_physical::<f64>(fallback_scale));
    let monitor = anchor_origin
        .and_then(|origin| app.monitor_from_point(origin.x, origin.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let monitor = monitor?;
    let scale = monitor.scale_factor();
    let tray_icon = anchor.map(|anchor| {
        let origin = anchor.position.to_physical::<f64>(scale);
        let size = anchor.size.to_physical::<f64>(scale);
        ScreenRect {
            x: origin.x,
            y: origin.y,
            width: size.width,
            height: size.height,
        }
    });
    let popover_size = window.outer_size().ok()?;
    let work_area = monitor.work_area();
    Some(flyout_origin(
        tray_icon,
        f64::from(popover_size.width),
        f64::from(popover_size.height),
        ScreenRect {
            x: f64::from(work_area.position.x),
            y: f64::from(work_area.position.y),
            width: f64::from(work_area.size.width),
            height: f64::from(work_area.size.height),
        },
        GAP_PIXELS * scale,
        EDGE_MARGIN_PIXELS * scale,
    ))
}

pub fn activate_for_dialog(_app: &AppHandle) {}

pub fn refocus_after_dialog(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_focus();
        }
    }
}

#[cfg(windows)]
mod backdrop {
    use tauri::window::Color;
    use tauri::{Theme, WebviewWindow};

    use super::{backdrop_chain, Backdrop};
    use crate::platform::windows_shell::current_build;

    /// `--color-popover` in each theme (styles/tokens.css), which the
    /// webview's translucent material tint lands on when there is no blur.
    const SOLID_LIGHT: Color = Color(252, 254, 252, 255);
    const SOLID_DARK: Color = Color(14, 24, 15, 255);

    pub fn apply(window: &WebviewWindow) {
        for backdrop in backdrop_chain(current_build()) {
            let applied = match backdrop {
                Backdrop::Mica => window_vibrancy::apply_mica(window, None).is_ok(),
                Backdrop::Acrylic => window_vibrancy::apply_acrylic(window, None).is_ok(),
                Backdrop::Solid => {
                    let solid = match window.theme() {
                        Ok(Theme::Dark) => SOLID_DARK,
                        _ => SOLID_LIGHT,
                    };
                    window.set_background_color(Some(solid)).is_ok()
                }
            };
            if applied {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDTH: f64 = 360.0;
    const HEIGHT: f64 = 540.0;
    const GAP: f64 = 12.0;
    const MARGIN: f64 = 12.0;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> ScreenRect {
        ScreenRect {
            x,
            y,
            width,
            height,
        }
    }

    fn place(tray: Option<ScreenRect>, work_area: ScreenRect) -> PopoverPlacement {
        flyout_origin(tray, WIDTH, HEIGHT, work_area, GAP, MARGIN)
    }

    fn assert_inside(placement: PopoverPlacement, work_area: ScreenRect, context: &str) {
        assert!(placement.x >= work_area.x, "{context}: {placement:?}");
        assert!(placement.y >= work_area.y, "{context}: {placement:?}");
        assert!(
            placement.x + WIDTH <= work_area.x + work_area.width,
            "{context}: {placement:?}"
        );
        assert!(
            placement.y + HEIGHT <= work_area.y + work_area.height,
            "{context}: {placement:?}"
        );
    }

    /// 1920x1080 monitor with a 40 px taskbar along the bottom.
    const BOTTOM_TASKBAR_WORK_AREA: ScreenRect = ScreenRect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };

    #[test]
    fn popover_clamped_inside_work_area_bottom_taskbar() {
        let tray = rect(1700.0, 1048.0, 24.0, 24.0);
        let placement = place(Some(tray), BOTTOM_TASKBAR_WORK_AREA);
        assert_eq!(
            placement,
            PopoverPlacement {
                x: 1712.0 - WIDTH / 2.0,
                y: 1040.0 - GAP - HEIGHT
            }
        );
        assert_inside(placement, BOTTOM_TASKBAR_WORK_AREA, "bottom");
    }

    #[test]
    fn popover_clamped_to_the_right_edge_for_an_icon_in_the_corner() {
        let placement = place(
            Some(rect(1890.0, 1048.0, 24.0, 24.0)),
            BOTTOM_TASKBAR_WORK_AREA,
        );
        assert_eq!(placement.x, 1920.0 - MARGIN - WIDTH);
        assert_eq!(placement.y, 1040.0 - GAP - HEIGHT);
    }

    #[test]
    fn popover_clamped_for_top_and_left_taskbar() {
        let top_work_area = rect(0.0, 40.0, 1920.0, 1040.0);
        let top = place(Some(rect(1700.0, 8.0, 24.0, 24.0)), top_work_area);
        assert_eq!(
            top,
            PopoverPlacement {
                x: 1712.0 - WIDTH / 2.0,
                y: 40.0 + GAP
            }
        );
        assert_inside(top, top_work_area, "top");

        let left_work_area = rect(60.0, 0.0, 1860.0, 1080.0);
        let left = place(Some(rect(18.0, 1000.0, 24.0, 24.0)), left_work_area);
        assert_eq!(
            left,
            PopoverPlacement {
                x: 60.0 + GAP,
                y: 1080.0 - MARGIN - HEIGHT
            }
        );
        assert_inside(left, left_work_area, "left");
    }

    #[test]
    fn popover_clamped_for_right_taskbar() {
        let right_work_area = rect(0.0, 0.0, 1860.0, 1080.0);
        let right = place(Some(rect(1878.0, 300.0, 24.0, 24.0)), right_work_area);
        assert_eq!(
            right,
            PopoverPlacement {
                x: 1860.0 - GAP - WIDTH,
                y: 312.0 - HEIGHT / 2.0
            }
        );
        assert_inside(right, right_work_area, "right");
    }

    #[test]
    fn popover_above_an_auto_hidden_taskbar_that_overlaps_the_work_area() {
        let whole_monitor = rect(0.0, 0.0, 1920.0, 1080.0);
        let placement = place(Some(rect(1700.0, 1050.0, 24.0, 24.0)), whole_monitor);
        assert_eq!(placement.y, 1050.0 - GAP - HEIGHT);
        assert_inside(placement, whole_monitor, "auto-hide");
    }

    #[test]
    fn popover_never_placed_offscreen_when_tray_rect_missing() {
        let secondary = rect(-1920.0, -200.0, 1920.0, 1040.0);
        for work_area in [BOTTOM_TASKBAR_WORK_AREA, secondary] {
            for tray in [
                None,
                // What a tray host without icon geometry reports.
                Some(rect(0.0, 0.0, 0.0, 0.0)),
                Some(rect(f64::NAN, 1048.0, 24.0, 24.0)),
                Some(rect(1700.0, f64::INFINITY, 24.0, 24.0)),
            ] {
                let placement = place(tray, work_area);
                assert_eq!(
                    placement,
                    PopoverPlacement {
                        x: work_area.x + work_area.width - MARGIN - WIDTH,
                        y: work_area.y + work_area.height - MARGIN - HEIGHT
                    },
                    "{tray:?} in {work_area:?}"
                );
                assert_inside(placement, work_area, "missing tray");
            }
        }
    }

    #[test]
    fn popover_never_placed_offscreen_for_an_icon_on_another_monitor() {
        for tray in [
            rect(-5000.0, 1048.0, 24.0, 24.0),
            rect(5000.0, 5000.0, 24.0, 24.0),
            rect(900.0, -3000.0, 24.0, 24.0),
        ] {
            let placement = place(Some(tray), BOTTOM_TASKBAR_WORK_AREA);
            assert_inside(placement, BOTTOM_TASKBAR_WORK_AREA, &format!("{tray:?}"));
        }
    }

    #[test]
    fn popover_pinned_to_the_work_area_origin_when_larger_than_it() {
        let tiny = rect(100.0, 50.0, 300.0, 400.0);
        let placement = place(Some(rect(350.0, 460.0, 24.0, 24.0)), tiny);
        assert_eq!(placement, PopoverPlacement { x: 100.0, y: 50.0 });
    }

    #[test]
    fn toggle_right_after_a_blur_hide_leaves_the_popover_closed() {
        // Clicking the tray icon blurs the open popover first; that click
        // means "close", not "close and reopen".
        assert!(!toggle_reopens(Some(Duration::ZERO)));
        assert!(!toggle_reopens(Some(Duration::from_millis(250))));
    }

    #[test]
    fn toggle_reopens_once_the_blur_hide_is_old_or_absent() {
        assert!(toggle_reopens(None));
        assert!(toggle_reopens(Some(Duration::from_millis(600))));
        assert!(toggle_reopens(Some(Duration::from_secs(60))));
    }

    #[test]
    fn a_blur_while_another_window_is_in_front_hides_the_popover() {
        assert_eq!(blur_response(false, false, false), BlurResponse::Hide);
        assert_eq!(blur_response(false, false, true), BlurResponse::Hide);
    }

    #[test]
    fn a_blur_inside_the_popover_itself_does_not_hide_it() {
        // A drag can move focus between the WebView2 child and the frame
        // while the popover stays the foreground window.
        assert_eq!(blur_response(false, true, false), BlurResponse::RecheckSoon);
        assert_eq!(blur_response(false, true, true), BlurResponse::KeepOpen);
    }

    #[test]
    fn a_suppressed_blur_never_hides_the_popover() {
        for foreground_is_popover in [false, true] {
            for recheck in [false, true] {
                assert_eq!(
                    blur_response(true, foreground_is_popover, recheck),
                    BlurResponse::KeepOpen
                );
            }
        }
    }

    #[test]
    fn win10_build_uses_solid_background() {
        for build in [10240, 17763, 19044, 19045, 21999] {
            assert_eq!(backdrop_chain(Some(build)), [Backdrop::Solid], "{build}");
        }
    }

    #[test]
    fn win11_build_prefers_mica_then_acrylic_then_solid() {
        for build in [22000, 22621, 22631, 26100] {
            assert_eq!(
                backdrop_chain(Some(build)),
                [Backdrop::Mica, Backdrop::Acrylic, Backdrop::Solid],
                "{build}"
            );
        }
    }

    #[test]
    fn unknown_windows_build_uses_solid_background() {
        assert_eq!(backdrop_chain(None), [Backdrop::Solid]);
    }

    fn popover_window(config: &str) -> serde_json::Value {
        let config: serde_json::Value = serde_json::from_str(config).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap().clone();
        assert_eq!(windows.len(), 1, "one window, the popover");
        windows[0].clone()
    }

    #[test]
    fn windows_overlay_keeps_the_popover_window_and_leaves_backdrops_to_runtime() {
        let base = popover_window(include_str!("../../tauri.conf.json"));
        let overlay = popover_window(include_str!("../../tauri.windows.conf.json"));
        // Tauri's config merge replaces arrays whole, so the overlay restates
        // the window; it must stay the same window.
        for key in [
            "label",
            "url",
            "width",
            "height",
            "resizable",
            "decorations",
            "visible",
            "focus",
            "skipTaskbar",
            "alwaysOnTop",
        ] {
            assert_eq!(overlay[key], base[key], "{key}");
        }
        // Mica, Acrylic or a solid fill is chosen per build at runtime; a
        // config effect would apply blindly (and silently fail) on Windows 10.
        assert!(overlay.get("windowEffects").is_none());
        // Mica and Acrylic show only through a transparent webview.
        assert_eq!(overlay["transparent"], true);
        assert_eq!(overlay["shadow"], true);
    }
}
