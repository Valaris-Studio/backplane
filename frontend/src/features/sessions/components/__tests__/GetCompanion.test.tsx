// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { COMPANION_RELEASE } from "@/lib/companion-release";
import { GetCompanion } from "../GetCompanion";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

function browseFrom(userAgent: string) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GetCompanion", () => {
  it("leads with the macOS download on a Mac", () => {
    browseFrom(MAC_UA);
    renderWithProviders(<GetCompanion />);

    expect(screen.getByRole("link", { name: "Download for macOS" })).toHaveAttribute("href", COMPANION_RELEASE.macDownloadUrl);
    expect(screen.getByText(new RegExp(COMPANION_RELEASE.version.replace(/\./g, "\\.")))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Linux and Windows/ })).toHaveAttribute("href", COMPANION_RELEASE.sourceUrl);
  });

  it.each([
    ["Windows", WINDOWS_UA],
    ["Linux", LINUX_UA],
  ])("tells %s visitors the desktop app is macOS-only and leads with the source build", (_, userAgent) => {
    browseFrom(userAgent);
    renderWithProviders(<GetCompanion />);

    expect(screen.getByText(/desktop app is macOS-only for now/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Build from source" })).toHaveAttribute("href", COMPANION_RELEASE.sourceUrl);
    expect(screen.getByRole("link", { name: "macOS download" })).toHaveAttribute("href", COMPANION_RELEASE.macDownloadUrl);
  });

  it("opens the external links in a new tab and links the setup guide in-app", () => {
    browseFrom(MAC_UA);
    renderWithProviders(<GetCompanion />);

    expect(screen.getByRole("link", { name: /Linux and Windows/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "Setup guide" })).toHaveAttribute(
      "href",
      "/documentation/capturing-sessions-with-companion",
    );
  });
});
