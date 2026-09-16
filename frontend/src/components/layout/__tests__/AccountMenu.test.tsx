// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { ApiKey } from "@/types/api-key";
import { AccountMenu } from "../AccountMenu";

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

const ADA = {
  id: "u1",
  email: "ada@valaris.dev",
  name: "Ada Lovelace",
  avatar_url: null,
};

const NO_NAME = {
  id: "u2",
  email: "zoe@example.com",
  name: "",
  avatar_url: null,
};

const PASSWORD_MODES = {
  oidc_enabled: false,
  password_enabled: true,
  dev_mode: false,
  login_path: "/api/auth/oidc/login",
  logout_path: "/api/auth/oidc/logout",
};

const OIDC_MODES = {
  ...PASSWORD_MODES,
  oidc_enabled: true,
  password_enabled: false,
};

const DEV_MODES = {
  ...PASSWORD_MODES,
  password_enabled: false,
  dev_mode: true,
};

const KEYS: ApiKey[] = [
  {
    id: "key-1",
    name: "Dev key",
    key_prefix: "val_abcd",
    created_at: "2026-04-01T00:00:00Z",
    last_used_at: null,
  },
];

function mockApis({
  user = ADA,
  modes = PASSWORD_MODES,
  keys = KEYS,
}: {
  user?: Record<string, unknown>;
  modes?: Record<string, unknown>;
  keys?: ApiKey[];
} = {}) {
  server.use(
    http.get("/api/me", () => HttpResponse.json(user)),
    http.get("/api/auth/modes", () => HttpResponse.json(modes)),
    http.get("/api/me/api-keys", () => HttpResponse.json(keys)),
  );
}

async function openMenu() {
  await userEvent.click(await screen.findByRole("button", { name: /account/i }));
}

describe("AccountMenu", () => {
  describe("identity", () => {
    it("shows the user's initials in the avatar trigger", async () => {
      mockApis();
      renderWithProviders(<AccountMenu />);

      const trigger = await screen.findByRole("button", { name: /account/i });
      await waitFor(() => {
        expect(trigger).toHaveTextContent("AL");
      });
    });

    it("falls back to email-derived initials when the user has no name", async () => {
      mockApis({ user: NO_NAME });
      renderWithProviders(<AccountMenu />);

      const trigger = await screen.findByRole("button", { name: /account/i });
      await waitFor(() => {
        expect(trigger).toHaveTextContent("ZO");
      });
    });

    it("renders the avatar image when the user has an avatar_url", async () => {
      mockApis({
        user: { ...ADA, avatar_url: "https://cdn.example.com/ada.png" },
      });
      renderWithProviders(<AccountMenu />);

      await waitFor(() => {
        expect(
          document.querySelector('img[src="https://cdn.example.com/ada.png"]'),
        ).toBeInTheDocument();
      });
    });

    it("shows name and email in the open menu", async () => {
      mockApis();
      renderWithProviders(<AccountMenu />);

      await openMenu();

      expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
      expect(screen.getByText("ada@valaris.dev")).toBeInTheDocument();
    });

    it("shows the email in place of the name when the user has no name", async () => {
      mockApis({ user: NO_NAME });
      renderWithProviders(<AccountMenu />);

      await openMenu();

      expect(
        (await screen.findAllByText("zoe@example.com")).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe("item visibility across auth modes", () => {
    it("password mode: offers change password, API keys, and sign out", async () => {
      mockApis({ modes: PASSWORD_MODES });
      renderWithProviders(<AccountMenu />);

      await openMenu();

      expect(await screen.findByText(/change password/i)).toBeInTheDocument();
      expect(screen.getByText(/api keys/i)).toBeInTheDocument();
      expect(screen.getByText(/sign out/i)).toBeInTheDocument();
    });

    it("OIDC mode: hides change password (no local credential to change)", async () => {
      mockApis({ modes: OIDC_MODES });
      renderWithProviders(<AccountMenu />);

      await openMenu();

      expect(await screen.findByText(/api keys/i)).toBeInTheDocument();
      expect(screen.getByText(/sign out/i)).toBeInTheDocument();
      expect(screen.queryByText(/change password/i)).not.toBeInTheDocument();
    });

    it("dev mode: hides both change password and sign out but keeps API keys", async () => {
      mockApis({ modes: DEV_MODES });
      renderWithProviders(<AccountMenu />);

      await openMenu();

      expect(await screen.findByText(/api keys/i)).toBeInTheDocument();
      expect(screen.queryByText(/change password/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/sign out/i)).not.toBeInTheDocument();
    });
  });

  describe("change-password dialog", () => {
    it("opens a dialog with current/new/confirm password fields", async () => {
      mockApis({ modes: PASSWORD_MODES });
      renderWithProviders(<AccountMenu />);

      await openMenu();
      await userEvent.click(await screen.findByText(/change password/i));

      expect(
        await screen.findByLabelText(/current password/i),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });
  });

  describe("API keys dialog", () => {
    it("opens a dialog listing the user's keys with a generate affordance", async () => {
      mockApis({ modes: DEV_MODES, keys: KEYS });
      renderWithProviders(<AccountMenu />);

      await openMenu();
      await userEvent.click(await screen.findByText(/api keys/i));

      expect(await screen.findByText("Dev key")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /generate/i }),
      ).toBeInTheDocument();
    });

    // Devops UX round 2 (#5): with many keys the dialog stretched past the
    // viewport. The key list must scroll inside a bounded region while the
    // header and Generate footer stay pinned flex siblings.
    it("scrolls a long key list inside the dialog instead of growing it", async () => {
      const manyKeys = Array.from({ length: 30 }, (_, i) => ({
        id: `key-${i}`,
        name: `Key ${i}`,
        key_prefix: `val_${i.toString().padStart(4, "0")}`,
        created_at: "2026-04-01T00:00:00Z",
        last_used_at: null,
      }));
      mockApis({ modes: DEV_MODES, keys: manyKeys });
      renderWithProviders(<AccountMenu />);

      await openMenu();
      await userEvent.click(await screen.findByText(/api keys/i));
      await screen.findByText("Key 0");

      const scrollRegion = screen.getByTestId("api-keys-scroll-region");
      expect(scrollRegion.className).toContain("overflow-y-auto");
      expect(scrollRegion.className).toContain("min-h-0");
      // The footer button must NOT live inside the scrolling region, or it
      // scrolls out of reach with the list.
      const generate = screen.getByRole("button", { name: /generate/i });
      expect(scrollRegion.contains(generate)).toBe(false);
      // The panel itself opts out of whole-panel scrolling.
      const panel = scrollRegion.closest(".overflow-hidden");
      expect(panel).not.toBeNull();
      expect(panel!.className).toContain("flex-col");
    });
  });

  describe("sign out", () => {
    const original = window.location;

    beforeEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        // Keep a REAL href: MSW resolves relative request/handler URLs against
        // location.href — an empty string breaks interception suite-wide.
        value: { assign: vi.fn(), pathname: "/acme/boards", href: original.href },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    });

    it("password mode: POSTs /auth/logout", async () => {
      let logoutCalled = false;
      mockApis({ modes: PASSWORD_MODES });
      server.use(
        http.post("/api/auth/logout", () => {
          logoutCalled = true;
          return HttpResponse.json({});
        }),
      );
      renderWithProviders(<AccountMenu />);

      await openMenu();
      await userEvent.click(await screen.findByText(/sign out/i));

      await waitFor(() => {
        expect(logoutCalled).toBe(true);
      });
    });

    it("OIDC mode: renders an anchor to the deployment's logout path", async () => {
      mockApis({ modes: OIDC_MODES });
      renderWithProviders(<AccountMenu />);

      await openMenu();

      const link = await screen.findByRole("link", { name: /sign out/i });
      expect(link).toHaveAttribute("href", "/api/auth/oidc/logout");
    });
  });
});
