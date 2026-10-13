// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Where the popover goes: centred under the tray icon, kept inside the
//! screen's visible frame (menu bar and Dock excluded). All values share one
//! unit and a top-left origin, as Tauri reports tray and monitor rects.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PopoverPlacement {
    pub x: f64,
    pub y: f64,
}

pub fn popover_origin(
    tray_icon: ScreenRect,
    popover_width: f64,
    popover_height: f64,
    visible_frame: ScreenRect,
    gap: f64,
    edge_margin: f64,
) -> PopoverPlacement {
    let frame_right = visible_frame.x + visible_frame.width;
    let frame_bottom = visible_frame.y + visible_frame.height;

    let centred_x = tray_icon.x + tray_icon.width / 2.0 - popover_width / 2.0;
    let min_x = visible_frame.x + edge_margin;
    let max_x = frame_right - edge_margin - popover_width;
    let x = if max_x < min_x {
        visible_frame.x
    } else {
        centred_x.clamp(min_x, max_x)
    };

    let below_icon = tray_icon.y + tray_icon.height + gap;
    // Top edge wins when the popover is taller than the frame.
    let y = below_icon
        .min(frame_bottom - popover_height)
        .max(visible_frame.y);

    PopoverPlacement { x, y }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: ScreenRect = ScreenRect {
        x: 0.0,
        y: 50.0,
        width: 3024.0,
        height: 1840.0,
    };
    const WIDTH: f64 = 720.0;
    const HEIGHT: f64 = 1040.0;

    fn icon_at(x: f64) -> ScreenRect {
        ScreenRect {
            x,
            y: 0.0,
            width: 44.0,
            height: 48.0,
        }
    }

    #[test]
    fn popover_origin_centres_under_the_icon() {
        let placement = popover_origin(icon_at(1500.0), WIDTH, HEIGHT, SCREEN, 8.0, 16.0);
        assert_eq!(
            placement,
            PopoverPlacement {
                x: 1500.0 + 22.0 - 360.0,
                y: 56.0
            }
        );
    }

    #[test]
    fn popover_origin_clamps_to_the_right_edge() {
        let placement = popover_origin(icon_at(2980.0), WIDTH, HEIGHT, SCREEN, 8.0, 16.0);
        assert_eq!(placement.x, 3024.0 - 16.0 - WIDTH);
    }

    #[test]
    fn popover_origin_clamps_to_the_left_edge() {
        let placement = popover_origin(icon_at(10.0), WIDTH, HEIGHT, SCREEN, 8.0, 16.0);
        assert_eq!(placement.x, 16.0);
    }

    #[test]
    fn popover_origin_pins_to_the_frame_when_wider_than_the_screen() {
        let narrow = ScreenRect {
            x: 0.0,
            y: 50.0,
            width: 600.0,
            height: 1840.0,
        };
        let placement = popover_origin(icon_at(300.0), WIDTH, HEIGHT, narrow, 8.0, 16.0);
        assert_eq!(placement.x, 0.0);
    }

    #[test]
    fn popover_origin_respects_a_secondary_monitor_with_negative_origin() {
        let left_monitor = ScreenRect {
            x: -1920.0,
            y: 25.0,
            width: 1920.0,
            height: 1055.0,
        };
        let icon = ScreenRect {
            x: -60.0,
            y: 0.0,
            width: 22.0,
            height: 24.0,
        };
        let placement = popover_origin(icon, 360.0, 520.0, left_monitor, 4.0, 8.0);
        assert_eq!(
            placement,
            PopoverPlacement {
                x: -8.0 - 360.0,
                y: 28.0
            }
        );
    }

    #[test]
    fn popover_origin_never_starts_above_the_visible_frame() {
        let placement = popover_origin(
            ScreenRect {
                x: 1500.0,
                y: -30.0,
                width: 44.0,
                height: 20.0,
            },
            WIDTH,
            HEIGHT,
            SCREEN,
            8.0,
            16.0,
        );
        assert_eq!(placement.y, 50.0);
    }

    #[test]
    fn popover_origin_lifts_the_popover_off_the_bottom_edge() {
        let short = ScreenRect {
            x: 0.0,
            y: 50.0,
            width: 3024.0,
            height: 900.0,
        };
        let placement = popover_origin(icon_at(1500.0), WIDTH, HEIGHT, short, 8.0, 16.0);
        assert_eq!(placement.y, 50.0);
        let barely_tall_enough = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 3024.0,
            height: 1060.0,
        };
        let placement = popover_origin(
            icon_at(1500.0),
            WIDTH,
            HEIGHT,
            barely_tall_enough,
            8.0,
            16.0,
        );
        assert_eq!(placement.y, 1060.0 - HEIGHT);
    }
}
