// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The popover as a non-activating NSPanel: it takes key focus for typing but
//! never activates the app (no Dock bounce, the frontmost app stays frontmost),
//! floats over full-screen spaces, and hides as soon as it loses key status.
//! Its header drags it (a panel drag never resigns key, so it stays open), and
//! it reopens where it was dragged to for the rest of the run.

#![allow(clippy::unused_unit)]

use tauri::{AppHandle, LogicalPosition, Manager, Rect, WebviewWindow};
use tauri_nspanel::objc2_app_kit::NSWindowStyleMask;
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, WebviewWindowExt};

use super::position::popover_origin;
use super::reopen::{in_points, PopoverExtent, PopoverPlacement, PopoverWindow, ScreenRect};
use super::{place_for_reopen, POPOVER_LABEL};
use crate::native::dialog_focus::POPOVER_BLUR;

const GAP_POINTS: f64 = 6.0;
const EDGE_MARGIN_POINTS: f64 = 8.0;

tauri_panel! {
    panel!(CompanionPopoverPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })

    panel_event!(CompanionPopoverEvents {
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(POPOVER_LABEL) else {
        return Ok(());
    };
    let panel = window.to_panel::<CompanionPopoverPanel>()?;
    panel.set_level(PanelLevel::PopUpMenu.value());
    if let Err(error) = panel.add_style_mask(NSWindowStyleMask::NonactivatingPanel) {
        log::warn!("popover panel kept an activating style mask: {error:?}");
    }
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .full_screen_auxiliary()
            .can_join_all_spaces()
            .value(),
    );

    let events = CompanionPopoverEvents::new();
    let handle = app.clone();
    events.window_did_resign_key(move |_| {
        if POPOVER_BLUR.is_suppressed() {
            return;
        }
        if let Ok(panel) = handle.get_webview_panel(POPOVER_LABEL) {
            panel.hide();
        }
    });
    panel.set_event_handler(Some(events.as_ref()));
    Ok(())
}

pub fn toggle(app: &AppHandle, anchor: Option<Rect>) {
    let Ok(panel) = app.get_webview_panel(POPOVER_LABEL) else {
        return;
    };
    if panel.is_visible() {
        panel.hide();
        return;
    }
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let under_tray = anchor.and_then(|anchor| origin_under(app, &window, anchor));
        place_for_reopen(&PanelInPoints(&window), under_tray);
    }
    panel.show_and_make_key();
}

/// The panel seen in points. Tauri's macOS "physical" pixels are points
/// times each screen's own scale, so a Retina screen and a 1x screen beside
/// it overlap in pixels; points line every screen up.
struct PanelInPoints<'a>(&'a WebviewWindow);

impl PanelInPoints<'_> {
    fn scale(&self) -> f64 {
        self.0.scale_factor().unwrap_or(1.0)
    }
}

impl PopoverWindow for PanelInPoints<'_> {
    fn origin(&self) -> Option<PopoverPlacement> {
        let origin = self
            .0
            .outer_position()
            .ok()?
            .to_logical::<f64>(self.scale());
        Some(PopoverPlacement {
            x: origin.x,
            y: origin.y,
        })
    }

    fn extent(&self) -> Option<PopoverExtent> {
        let size = self.0.outer_size().ok()?.to_logical::<f64>(self.scale());
        Some(PopoverExtent {
            width: size.width,
            height: size.height,
            scale: 1.0,
        })
    }

    fn display_frames(&self) -> Vec<ScreenRect> {
        self.0
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|monitor| {
                in_points(
                    ScreenRect {
                        x: f64::from(monitor.position().x),
                        y: f64::from(monitor.position().y),
                        width: f64::from(monitor.size().width),
                        height: f64::from(monitor.size().height),
                    },
                    monitor.scale_factor(),
                )
            })
            .collect()
    }

    fn move_to(&self, origin: PopoverPlacement) {
        let _ = self
            .0
            .set_position(LogicalPosition::new(origin.x, origin.y));
    }

    /// Without a tray rect the panel stays where it last was.
    fn fallback(&self) {}
}

/// Centred under the tray icon, in points.
fn origin_under(app: &AppHandle, window: &WebviewWindow, anchor: Rect) -> Option<PopoverPlacement> {
    let fallback_scale = window.scale_factor().unwrap_or(1.0);
    let anchor_origin = anchor.position.to_physical::<f64>(fallback_scale);
    let monitor = app
        .monitor_from_point(anchor_origin.x, anchor_origin.y)
        .ok()
        .flatten()?;
    let monitor_scale = monitor.scale_factor();
    let anchor_origin = anchor.position.to_logical::<f64>(monitor_scale);
    let anchor_size = anchor.size.to_logical::<f64>(monitor_scale);
    let work_area = monitor.work_area();
    let work_area = in_points(
        ScreenRect {
            x: f64::from(work_area.position.x),
            y: f64::from(work_area.position.y),
            width: f64::from(work_area.size.width),
            height: f64::from(work_area.size.height),
        },
        monitor_scale,
    );
    let popover = PanelInPoints(window).extent()?;
    Some(popover_origin(
        ScreenRect {
            x: anchor_origin.x,
            y: anchor_origin.y,
            width: anchor_size.width,
            height: anchor_size.height,
        },
        popover.width,
        popover.height,
        work_area,
        GAP_POINTS,
        EDGE_MARGIN_POINTS,
    ))
}

/// An accessory app (no Dock icon) is usually not active when the tray is
/// clicked; without activating, a native dialog can open behind other apps.
pub fn activate_for_dialog(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if let Some(main_thread) = tauri_nspanel::objc2::MainThreadMarker::new() {
            // `activate()` needs macOS 14; the app supports 13.
            #[allow(deprecated)]
            tauri_nspanel::objc2_app_kit::NSApplication::sharedApplication(main_thread)
                .activateIgnoringOtherApps(true);
        }
    });
}

/// Hands key status back to a still-visible popover once its dialog closes,
/// so the next click elsewhere hides it again.
pub fn refocus_after_dialog(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(panel) = handle.get_webview_panel(POPOVER_LABEL) {
            if panel.is_visible() {
                panel.show_and_make_key();
            }
        }
    });
}
