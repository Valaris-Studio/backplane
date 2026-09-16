// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import { NotificationBell } from "../NotificationBell";

// Empirically verified (scratch probe against the real gsap module in jsdom):
// gsap.set([], {...}) DOES call console.warn("GSAP target  not found. ...") —
// it is not a silent no-op. So the real bug is call-level (an empty/all-null
// target array reaching gsap.set), and the most faithful pin runs the REAL
// gsap module and spies on console.warn, rather than mocking gsap away.
vi.mock("../NotificationInbox", () => ({
  __esModule: true,
  NotificationInbox: () => null,
}));

const unreadCountMock = vi.fn();
vi.mock("../../api/use-notifications", () => ({
  __esModule: true,
  useUnreadCount: (slug?: string) => unreadCountMock(slug),
  useNotificationLiveSync: vi.fn(),
}));

describe("NotificationBell", () => {
  it("does not warn 'GSAP target not found' on a zero-unread mount/unmount cycle", () => {
    // Zero unread: badgeRef/pulseRef never mount (the badge markup is gated
    // behind hasUnread), so the effect's cleanup calls
    // gsap.set([badge, pulse].filter(Boolean), ...) === gsap.set([], ...)
    // against the REAL gsap module, which warns unless the cleanup guards
    // against an empty target list.
    unreadCountMock.mockReturnValue({ data: 0 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unmount } = renderWithProviders(<NotificationBell slug="ws1" />);
    unmount();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn 'GSAP target not found' when unread count returns to zero", () => {
    // A prev>0 -> 0 transition tweens the badge out, then its OWN cleanup
    // (next render or unmount) hits the same empty-array path once the badge
    // unmounts from the DOM.
    unreadCountMock.mockReturnValue({ data: 3 });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rerender, unmount } = renderWithProviders(
      <NotificationBell slug="ws1" />,
    );
    unreadCountMock.mockReturnValue({ data: 0 });
    rerender(<NotificationBell slug="ws1" />);
    unmount();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
