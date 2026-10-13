// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Where the popover opens after the user has dragged it: back on that spot
//! for the rest of the run, unless no display still shows enough of its
//! header (the only drag handle), in which case it goes under the tray again.
//!
//! Every value shares one unit per platform: points on macOS, where Tauri's
//! "physical" pixels are points times each screen's own scale and so overlap
//! across mixed-scale displays; virtual-screen pixels on Windows.

pub use super::position::{PopoverPlacement, ScreenRect};

/// Rounding between points and pixels can shift a placed window by a pixel
/// or two without anyone touching it.
const PLACEMENT_TOLERANCE: f64 = 2.0;
/// The strip of header, in points, a display must show for a remembered spot
/// to count: enough to grab it again.
const HEADER_GRIP_HEIGHT_POINTS: f64 = 24.0;
const HEADER_GRIP_WIDTH_POINTS: f64 = 64.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PopoverExtent {
    pub width: f64,
    pub height: f64,
    /// Units per point: 1 when working in points, the window's scale factor
    /// when working in pixels.
    pub scale: f64,
}

/// A macOS screen rect from Tauri's per-screen pixels into points.
pub fn in_points(pixels: ScreenRect, scale: f64) -> ScreenRect {
    ScreenRect {
        x: pixels.x / scale,
        y: pixels.y / scale,
        width: pixels.width / scale,
        height: pixels.height / scale,
    }
}

/// Whether the window sits somewhere other than every spot the app recorded
/// placing it at.
pub fn user_moved(recorded: &[PopoverPlacement], current: PopoverPlacement) -> bool {
    !recorded.is_empty()
        && recorded.iter().all(|placed| {
            (placed.x - current.x).abs() > PLACEMENT_TOLERANCE
                || (placed.y - current.y).abs() > PLACEMENT_TOLERANCE
        })
}

/// Whether the displays together show a grip-sized strip of the header.
/// Display frames, not work areas: the popover floats over the menu bar and
/// taskbar. Side-by-side displays add up, so a header straddling the seam counts.
pub fn header_reachable(
    origin: PopoverPlacement,
    popover: PopoverExtent,
    displays: &[ScreenRect],
) -> bool {
    let grip_height = (HEADER_GRIP_HEIGHT_POINTS * popover.scale).min(popover.height);
    let grip_width = (HEADER_GRIP_WIDTH_POINTS * popover.scale).min(popover.width);
    let grip_top = origin.y;
    let grip_bottom = origin.y + grip_height;
    let shown_width: f64 = displays
        .iter()
        .filter(|display| grip_top >= display.y && grip_bottom <= display.y + display.height)
        .map(|display| {
            let left = origin.x.max(display.x);
            let right = (origin.x + popover.width).min(display.x + display.width);
            (right - left).max(0.0)
        })
        .sum();
    shown_width >= grip_width
}

/// The popover window as placement sees it, in the platform's unit.
pub trait PopoverWindow {
    fn origin(&self) -> Option<PopoverPlacement>;
    fn extent(&self) -> Option<PopoverExtent>;
    fn display_frames(&self) -> Vec<ScreenRect>;
    fn move_to(&self, origin: PopoverPlacement);
    /// Where the window goes with neither a tray anchor nor a dragged spot.
    fn fallback(&self);
}

/// Kept for this run only: a restart opens under the tray again.
#[derive(Debug, Default)]
pub struct PlacementMemory {
    /// Both where the app asked the window to go and where it read it back
    /// afterwards: the OS may nudge a frame (DPI snapping), and macOS applies
    /// a move only after the read-back, so either can be the true spot.
    placed_at: Vec<PopoverPlacement>,
    dragged_to: Option<PopoverPlacement>,
}

impl PlacementMemory {
    pub const fn new() -> Self {
        Self {
            placed_at: Vec::new(),
            dragged_to: None,
        }
    }
}

/// Positions the popover just before it is shown. A hidden window keeps its
/// frame, so where it sits now, if that is none of the spots the app put it
/// at, is where the user dragged it.
pub fn place_for_reopen(
    window: &impl PopoverWindow,
    memory: &mut PlacementMemory,
    tray_anchored: Option<PopoverPlacement>,
) {
    if let Some(current) = window.origin() {
        if user_moved(&memory.placed_at, current) {
            memory.dragged_to = Some(current);
        }
    }
    let displays = window.display_frames();
    let dragged_and_reachable = window.extent().and_then(|popover| {
        memory
            .dragged_to
            .filter(|origin| header_reachable(*origin, popover, &displays))
    });
    let target = dragged_and_reachable.or(tray_anchored);
    match target {
        Some(target) => window.move_to(target),
        None => window.fallback(),
    }
    memory.placed_at = target.into_iter().chain(window.origin()).collect();
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    const POPOVER: PopoverExtent = PopoverExtent {
        width: 360.0,
        height: 540.0,
        scale: 1.0,
    };
    /// A 1512x982 pt Retina laptop panel, in points.
    const LAPTOP: ScreenRect = ScreenRect {
        x: 0.0,
        y: 0.0,
        width: 1512.0,
        height: 982.0,
    };
    /// A 1920x1080 1x display to the laptop's right, in points.
    const EXTERNAL: ScreenRect = ScreenRect {
        x: 1512.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    const ANCHORED: PopoverPlacement = PopoverPlacement { x: 1100.0, y: 30.0 };

    fn at(x: f64, y: f64) -> PopoverPlacement {
        PopoverPlacement { x, y }
    }

    // --- reachability ----------------------------------------------------

    #[test]
    fn a_header_on_a_display_is_reachable() {
        assert!(header_reachable(at(600.0, 300.0), POPOVER, &[LAPTOP]));
    }

    #[test]
    fn a_header_over_the_menu_bar_or_taskbar_is_still_reachable() {
        // The panel floats above the menu bar, so the full frame counts.
        assert!(header_reachable(at(600.0, 0.0), POPOVER, &[LAPTOP]));
    }

    #[test]
    fn a_header_above_every_display_is_not_reachable() {
        assert!(!header_reachable(at(600.0, -10.0), POPOVER, &[LAPTOP]));
    }

    #[test]
    fn a_header_split_across_side_by_side_displays_counts_as_one_strip() {
        // 40 pt on each side: neither display alone shows the 64 pt grip.
        let straddling = at(1512.0 - 40.0, 300.0);
        let narrow = PopoverExtent {
            width: 80.0,
            ..POPOVER
        };
        assert!(!header_reachable(straddling, narrow, &[LAPTOP]));
        assert!(!header_reachable(straddling, narrow, &[EXTERNAL]));
        assert!(header_reachable(straddling, narrow, &[LAPTOP, EXTERNAL]));
    }

    #[test]
    fn the_grip_grows_with_the_scale_factor() {
        // 50 px showing: enough at 100 %, not at 200 % (128 px needed).
        let mostly_off_the_right = at(1512.0 - 50.0, 300.0);
        assert!(!header_reachable(mostly_off_the_right, POPOVER, &[LAPTOP]));
        let showing_100 = at(1512.0 - 70.0, 300.0);
        assert!(header_reachable(showing_100, POPOVER, &[LAPTOP]));
        let at_200 = PopoverExtent {
            scale: 2.0,
            ..POPOVER
        };
        assert!(!header_reachable(showing_100, at_200, &[LAPTOP]));
        let showing_130 = at(1512.0 - 130.0, 300.0);
        assert!(header_reachable(showing_130, at_200, &[LAPTOP]));
        // The 24 pt grip height doubles too: 40 px of header above the bottom is not enough.
        let near_the_bottom = at(600.0, 982.0 - 40.0);
        assert!(header_reachable(near_the_bottom, POPOVER, &[LAPTOP]));
        assert!(!header_reachable(near_the_bottom, at_200, &[LAPTOP]));
    }

    #[test]
    fn a_header_partly_off_the_side_stays_reachable_while_enough_shows() {
        assert!(header_reachable(at(-150.0, 300.0), POPOVER, &[LAPTOP]));
    }

    #[test]
    fn nothing_is_reachable_without_a_known_display() {
        assert!(!header_reachable(at(600.0, 300.0), POPOVER, &[]));
    }

    // --- macOS points --------------------------------------------------------

    #[test]
    fn mixed_scale_displays_line_up_once_in_points() {
        // macOS "physical" = points x each screen's own scale: the Retina
        // laptop spans 0-3024 px while the 1x display to its right starts at
        // 1512 px, so the two overlap in pixels.
        let laptop_px = ScreenRect {
            x: 0.0,
            y: 0.0,
            width: 3024.0,
            height: 1964.0,
        };
        let external_px = ScreenRect {
            x: 1512.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(in_points(laptop_px, 2.0), LAPTOP);
        assert_eq!(in_points(external_px, 1.0), EXTERNAL);
    }

    #[test]
    fn a_spot_on_an_unplugged_external_display_is_not_reachable_in_points() {
        // Left on the 1x display at 2000 pt; with it gone only the laptop's
        // 0-1512 pt remain. In mixed pixels the laptop's 3024 px would have
        // swallowed it.
        assert!(!header_reachable(at(2000.0, 300.0), POPOVER, &[LAPTOP]));
        assert!(header_reachable(
            at(2000.0, 300.0),
            POPOVER,
            &[LAPTOP, EXTERNAL]
        ));
    }

    // --- move detection ------------------------------------------------------

    #[test]
    fn nothing_recorded_means_nothing_was_moved() {
        assert!(!user_moved(&[], at(0.0, 0.0)));
    }

    #[test]
    fn a_window_within_rounding_of_a_recorded_spot_was_not_moved() {
        assert!(!user_moved(&[ANCHORED], ANCHORED));
        assert!(!user_moved(&[ANCHORED], at(1101.0, 29.0)));
        assert!(!user_moved(&[at(5.0, 5.0), ANCHORED], ANCHORED));
    }

    #[test]
    fn a_window_away_from_every_recorded_spot_was_dragged() {
        assert!(user_moved(&[ANCHORED, at(5.0, 5.0)], at(600.0, 300.0)));
    }

    // --- bookkeeping through a fake window ------------------------------------

    #[derive(Clone, Copy)]
    enum MoveBehaviour {
        Exact,
        /// The OS nudges the frame (DPI snapping, keeping it on screen).
        NudgedBy(f64),
        /// The move lands only after the caller has read the position back
        /// (macOS dispatches frame changes to the main queue).
        AppliedLater,
    }

    struct FakeWindow {
        origin: Cell<Option<PopoverPlacement>>,
        displays: Vec<ScreenRect>,
        behaviour: MoveBehaviour,
        pending: Cell<Option<PopoverPlacement>>,
        moves: RefCell<Vec<PopoverPlacement>>,
        fallbacks: Cell<u32>,
        fallback_lands_at: PopoverPlacement,
    }

    impl FakeWindow {
        fn at(origin: PopoverPlacement) -> Self {
            Self {
                origin: Cell::new(Some(origin)),
                displays: vec![LAPTOP, EXTERNAL],
                behaviour: MoveBehaviour::Exact,
                pending: Cell::new(None),
                moves: RefCell::new(Vec::new()),
                fallbacks: Cell::new(0),
                fallback_lands_at: at(576.0, 221.0),
            }
        }

        fn user_drags_to(&self, to: PopoverPlacement) {
            self.settle();
            self.origin.set(Some(to));
        }

        /// The main queue runs: a deferred move lands.
        fn settle(&self) {
            if let Some(landed) = self.pending.take() {
                self.origin.set(Some(landed));
            }
        }
    }

    impl PopoverWindow for FakeWindow {
        fn origin(&self) -> Option<PopoverPlacement> {
            self.origin.get()
        }
        fn extent(&self) -> Option<PopoverExtent> {
            Some(POPOVER)
        }
        fn display_frames(&self) -> Vec<ScreenRect> {
            self.displays.clone()
        }
        fn move_to(&self, origin: PopoverPlacement) {
            self.moves.borrow_mut().push(origin);
            match self.behaviour {
                MoveBehaviour::Exact => self.origin.set(Some(origin)),
                MoveBehaviour::NudgedBy(offset) => self
                    .origin
                    .set(Some(at(origin.x + offset, origin.y + offset))),
                MoveBehaviour::AppliedLater => self.pending.set(Some(origin)),
            }
        }
        fn fallback(&self) {
            self.fallbacks.set(self.fallbacks.get() + 1);
            self.origin.set(Some(self.fallback_lands_at));
        }
    }

    fn open(window: &FakeWindow, memory: &mut PlacementMemory, anchor: Option<PopoverPlacement>) {
        window.settle();
        place_for_reopen(window, memory, anchor);
    }

    #[test]
    fn first_open_goes_under_the_tray_whatever_the_config_position() {
        let window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        assert_eq!(*window.moves.borrow(), [ANCHORED]);
    }

    #[test]
    fn a_drag_is_detected_before_placing_and_wins_over_the_anchor() {
        let window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        window.user_drags_to(at(600.0, 300.0));
        open(&window, &mut memory, Some(ANCHORED));
        assert_eq!(window.moves.borrow().last(), Some(&at(600.0, 300.0)));
        // And keeps winning on later opens.
        open(&window, &mut memory, Some(ANCHORED));
        assert_eq!(window.moves.borrow().last(), Some(&at(600.0, 300.0)));
    }

    #[test]
    fn an_os_nudge_after_placing_is_not_mistaken_for_a_drag() {
        let mut window = FakeWindow::at(at(0.0, 0.0));
        window.behaviour = MoveBehaviour::NudgedBy(7.0);
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        let tray_moved = at(900.0, 30.0);
        open(&window, &mut memory, Some(tray_moved));
        assert_eq!(window.moves.borrow().last(), Some(&tray_moved));
    }

    #[test]
    fn a_move_that_lands_after_the_read_back_is_not_mistaken_for_a_drag() {
        let mut window = FakeWindow::at(at(0.0, 0.0));
        window.behaviour = MoveBehaviour::AppliedLater;
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        let tray_moved = at(900.0, 30.0);
        open(&window, &mut memory, Some(tray_moved));
        assert_eq!(window.moves.borrow().last(), Some(&tray_moved));
    }

    #[test]
    fn the_fallback_spot_is_recorded_so_the_next_open_does_not_snap_back() {
        let window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, None);
        assert_eq!(window.fallbacks.get(), 1);
        assert!(window.moves.borrow().is_empty());
        // Untouched, the next anchored open still goes under the tray...
        open(&window, &mut memory, Some(ANCHORED));
        assert_eq!(*window.moves.borrow(), [ANCHORED]);
    }

    #[test]
    fn an_open_without_an_anchor_returns_to_a_dragged_spot() {
        let window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        window.user_drags_to(at(600.0, 300.0));
        open(&window, &mut memory, None);
        assert_eq!(window.moves.borrow().last(), Some(&at(600.0, 300.0)));
        assert_eq!(window.fallbacks.get(), 0);
    }

    #[test]
    fn an_open_without_an_anchor_or_drag_uses_the_fallback() {
        let window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, None);
        open(&window, &mut memory, None);
        assert_eq!(window.fallbacks.get(), 2);
    }

    #[test]
    fn a_spot_on_an_unplugged_display_reopens_under_the_tray() {
        let mut window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        window.user_drags_to(at(2000.0, 300.0));
        window.displays = vec![LAPTOP];
        open(&window, &mut memory, Some(ANCHORED));
        assert_eq!(window.moves.borrow().last(), Some(&ANCHORED));
    }

    #[test]
    fn an_unreadable_position_never_counts_as_a_drag() {
        let window = FakeWindow::at(at(0.0, 0.0));
        let mut memory = PlacementMemory::default();
        open(&window, &mut memory, Some(ANCHORED));
        window.origin.set(None);
        open(&window, &mut memory, Some(at(900.0, 30.0)));
        assert_eq!(window.moves.borrow().last(), Some(&at(900.0, 30.0)));
    }
}
