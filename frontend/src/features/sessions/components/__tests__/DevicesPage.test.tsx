// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { Toaster, toast } from "sonner";
import i18n from "@/i18n/config";
import { act, renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { CompanionInstallation, CompanionMapping } from "@/types/agent-session";
import { SLUG, minutesAgo, stubAuthModes } from "../../__tests__/fixtures";
import { setPromptsHidden } from "../../hooks/use-hide-prompts";
import { DevicesPage } from "../DevicesPage";

const DEVICES = "/api/me/companion/installations";
const POLICY = { paused: false, auto_match_repos: true, enabled_agents: ["claude_code", "pi_cli"], exclude_globs: ["**/.env*", "**/secrets/**"], retention_days: 90 };

function device(overrides: Partial<CompanionInstallation> = {}): CompanionInstallation {
  return {
    installation_id: "dev-mac",
    name: "Carol's MacBook Pro",
    platform: "darwin",
    token_prefix: "bpc_",
    created_at: minutesAgo(90_000),
    last_seen_at: minutesAgo(1),
    revoked_at: null,
    policy: POLICY,
    status: {
      companion_version: "0.9.0",
      agents: [
        { harness: "claude_code", state: "capturing" },
        { harness: "pi_cli", state: "not_installed" },
      ],
      queue: { pending: 0, dropped_total: 0 },
    },
    status_reported_at: minutesAgo(1),
    session_count: 12,
    ...overrides,
  };
}

function mapping(overrides: Partial<CompanionMapping> = {}): CompanionMapping {
  return {
    id: "map-1",
    installation_id: "dev-mac",
    workspace_id: "ws-1",
    board_id: "board-1",
    root_path: "/home/operator/code/backplane",
    repo_url_normalized: "github.com/valaris/backplane",
    origin: "auto_repo",
    enabled: true,
    content_level: "standard",
    created_at: minutesAgo(9000),
    updated_at: minutesAgo(9000),
    ...overrides,
  };
}

interface Calls {
  patches: { url: string; body: unknown }[];
  deletes: string[];
}

function serve(devices: CompanionInstallation[] = [device()], mappings: CompanionMapping[] = [mapping()]) {
  stubAuthModes(true);
  const calls: Calls = { patches: [], deletes: [] };
  server.use(
    http.get(`/api/workspaces/${SLUG}`, () => HttpResponse.json({ id: "ws-1", slug: SLUG, name: "internal-projects" })),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([{ id: "board-1", name: "Backplane" }])),
    http.get(DEVICES, () => HttpResponse.json(devices)),
    http.get(`${DEVICES}/:id/mappings`, ({ params }) =>
      HttpResponse.json(mappings.filter((candidate) => candidate.installation_id === params.id)),
    ),
    http.patch(`${DEVICES}/:id/policy`, async ({ request }) => {
      calls.patches.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ ...POLICY, paused: true });
    }),
    http.patch(`${DEVICES}/:id/mappings/:mappingId`, async ({ request }) => {
      calls.patches.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json(mapping());
    }),
    http.patch(`${DEVICES}/:id`, async ({ request }) => {
      calls.patches.push({ url: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json(device());
    }),
    http.delete(`${DEVICES}/:id/sessions`, ({ request }) => {
      calls.deletes.push(new URL(request.url).pathname);
      return HttpResponse.json({ deleted: 12 });
    }),
    http.delete(`${DEVICES}/:id`, ({ request }) => {
      calls.deletes.push(new URL(request.url).pathname);
      return HttpResponse.json(device({ revoked_at: minutesAgo(0) }));
    }),
  );
  return calls;
}

function renderDevices() {
  renderWithProviders(
    <>
      <Routes>
        <Route path="/:slug/sessions/devices" element={<DevicesPage />} />
      </Routes>
      <Toaster />
    </>,
    { routerProps: { initialEntries: [`/${SLUG}/sessions/devices`] } },
  );
}

function panel(name: string) {
  return screen.getByRole("region", { name });
}

afterEach(() => {
  act(() => setPromptsHidden(false));
});

describe("Devices", () => {
  it("states each device's condition in words, from its own report", async () => {
    serve([
      device(),
      device({ installation_id: "dev-paused", name: "Studio", policy: { ...POLICY, paused: true } }),
      device({ installation_id: "dev-box", name: "Build box", last_seen_at: minutesAgo(3 * 24 * 60), status: { companion_version: "0.8.4", agents: [], queue: { pending: 214, dropped_total: 0 } } }),
      device({ installation_id: "dev-old", name: "ThinkPad", revoked_at: minutesAgo(9 * 24 * 60) }),
    ]);
    renderDevices();

    const mac = await screen.findByRole("region", { name: "Carol's MacBook Pro" });
    expect(within(mac).getByText("Capturing")).toBeInTheDocument();
    expect(within(mac).getByText("Companion 0.9.0")).toBeInTheDocument();
    expect(within(panel("Studio")).getByText("Paused")).toBeInTheDocument();
    const box = panel("Build box");
    expect(within(box).getByText("Disconnected")).toBeInTheDocument();
    expect(within(box).getByText("214 records waiting to upload")).toBeInTheDocument();
    const old = panel("ThinkPad");
    expect(within(old).getByText("Signed out")).toBeInTheDocument();
    expect(within(old).queryByRole("button", { name: "Pause capture" })).not.toBeInTheDocument();
  });

  it("shows what each agent on the device is doing", async () => {
    serve();
    renderDevices();
    const mac = await screen.findByRole("region", { name: "Carol's MacBook Pro" });
    expect(within(mac).getByText("capturing")).toBeInTheDocument();
    expect(within(mac).getByText("not installed")).toBeInTheDocument();
  });

  it("lists only the folders that send to this workspace, and counts the rest", async () => {
    serve([device()], [mapping(), mapping({ id: "map-2", workspace_id: "ws-other", root_path: "/home/operator/code/acme" })]);
    renderDevices();
    const folders = await screen.findByRole("table", { name: "Folders sending to internal-projects" });
    expect(within(folders).getByText("~/code/backplane")).toBeInTheDocument();
    expect(within(folders).queryByText("~/code/acme")).not.toBeInTheDocument();
    expect(within(folders).getByText("Backplane")).toBeInTheDocument();
    expect(screen.getByText("1 folder sends to other workspaces")).toBeInTheDocument();
  });

  it("changes what a folder sends and says it applies to what's captured next", async () => {
    const calls = serve();
    renderDevices();
    const level = await screen.findByRole("group", { name: "What ~/code/backplane sends" });
    await userEvent.click(within(level).getByRole("button", { name: "Full" }));
    await waitFor(() => expect(calls.patches).toContainEqual({ url: `${DEVICES}/dev-mac/mappings/map-1`, body: { content_level: "full" } }));
    expect(await screen.findByText("Applies to what's captured next. Sessions already sent keep what they sent.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "Capture ~/code/backplane" }));
    await waitFor(() => expect(calls.patches).toContainEqual({ url: `${DEVICES}/dev-mac/mappings/map-1`, body: { enabled: false } }));
  });

  it("pauses capture on a device", async () => {
    const calls = serve();
    renderDevices();
    await userEvent.click(await screen.findByRole("button", { name: "Pause capture" }));
    await waitFor(() => expect(calls.patches).toContainEqual({ url: `${DEVICES}/dev-mac/policy`, body: { paused: true } }));
  });

  it("renames a device from the web", async () => {
    const calls = serve();
    renderDevices();
    await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", { name: "Device name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Work laptop");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.patches).toContainEqual({ url: `${DEVICES}/dev-mac`, body: { name: "Work laptop" } }));
  });

  it("says exactly what deleting a device's sessions removes, where, and what it keeps", async () => {
    serve();
    renderDevices();
    await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete this device's sessions" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 12 sessions from this device?" });
    const body = dialog.textContent ?? "";
    expect(body).toContain("every session this device captured");
    expect(body).toContain("in all your workspaces, not only this one");
    expect(body).toContain("can't be undone");
    expect(body).toContain("Linked cards and notes are kept");
  });

  describe("when the server refuses a device action", () => {
    const FAILED = "Couldn't update the device";
    const refuse = () => HttpResponse.json({ detail: "nope" }, { status: 500 });
    // sonner's store is module-global, so a toast from one test can surface in the next.
    let errorToast: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errorToast = vi.spyOn(toast, "error");
    });
    afterEach(() => errorToast.mockRestore());
    const toldFailure = () => waitFor(() => expect(errorToast).toHaveBeenCalledWith(FAILED));

    it("says so when pausing fails", async () => {
      serve();
      server.use(http.patch(`${DEVICES}/:id/policy`, refuse));
      renderDevices();
      await userEvent.click(await screen.findByRole("button", { name: "Pause capture" }));
      await toldFailure();
    });

    it("says so when renaming fails, and keeps the dialog open", async () => {
      serve();
      server.use(http.patch(`${DEVICES}/:id`, refuse));
      renderDevices();
      await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      const field = await screen.findByRole("textbox", { name: "Device name" });
      await userEvent.clear(field);
      await userEvent.type(field, "Work laptop");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await toldFailure();
      expect(screen.getByRole("textbox", { name: "Device name" })).toBeInTheDocument();
    });

    it("says so when deleting sessions fails, and keeps the confirm open", async () => {
      serve();
      server.use(http.delete(`${DEVICES}/:id/sessions`, refuse));
      renderDevices();
      await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete this device's sessions" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete 12 sessions" }));
      await toldFailure();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByText(/^Deleted \d+ session/)).not.toBeInTheDocument();
    });

    it("says so when signing out fails, and keeps the confirm open", async () => {
      serve();
      server.use(http.delete(`${DEVICES}/:id`, refuse));
      renderDevices();
      await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Sign out this device" }));
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign out" }));
      await toldFailure();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("deletes a device's sessions and signs a device out, each after confirmation", async () => {
    const calls = serve();
    renderDevices();
    await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete this device's sessions" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete 12 sessions" }));
    await waitFor(() => expect(calls.deletes).toContain(`${DEVICES}/dev-mac/sessions`));
    expect(await screen.findByText("Deleted 12 sessions")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More actions for Carol's MacBook Pro" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out this device" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(calls.deletes).toContain(`${DEVICES}/dev-mac`));
  });

  describe("the delete-sessions confirm states how many sessions go", () => {
    async function openDeleteConfirm(name = "Carol's MacBook Pro") {
      await userEvent.click(await screen.findByRole("button", { name: `More actions for ${name}` }));
      await userEvent.click(screen.getByRole("menuitem", { name: "Delete this device's sessions" }));
      return within(await screen.findByRole("dialog"));
    }

    it("puts the count in the question and on the button", async () => {
      serve([device({ session_count: 38 })]);
      renderDevices();
      const dialog = await openDeleteConfirm();
      expect(dialog.getByRole("heading", { name: "Delete 38 sessions from this device?" })).toBeInTheDocument();
      expect(dialog.getByText(/in all your workspaces, not only this one/)).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Delete 38 sessions" })).toBeInTheDocument();
    });

    it("says one session in the singular", async () => {
      serve([device({ session_count: 1 })]);
      renderDevices();
      const dialog = await openDeleteConfirm();
      expect(dialog.getByRole("heading", { name: "Delete 1 session from this device?" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Delete 1 session" })).toBeInTheDocument();
    });

    it("falls back to every session when the server sends no count", async () => {
      serve([device({ session_count: undefined })]);
      renderDevices();
      const dialog = await openDeleteConfirm();
      expect(dialog.getByRole("heading", { name: "Delete every session from this device?" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Delete all sessions" })).toBeInTheDocument();
    });

    it("offers no delete for a device with nothing to delete", async () => {
      serve([
        device({ session_count: 0 }),
        device({ installation_id: "dev-old", name: "ThinkPad", revoked_at: minutesAgo(9 * 24 * 60), session_count: 0 }),
      ]);
      renderDevices();
      await userEvent.click(await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" }));
      expect(screen.queryByRole("menuitem", { name: "Delete this device's sessions" })).not.toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Sign out this device" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "More actions for ThinkPad" })).not.toBeInTheDocument();
    });

    it("refetches the count when the confirm opens, so it states what the delete removes now", async () => {
      let served = device({ session_count: 12 });
      serve();
      server.use(http.get(DEVICES, () => HttpResponse.json([served])));
      renderDevices();
      await screen.findByRole("button", { name: "More actions for Carol's MacBook Pro" });
      served = device({ session_count: 38 });
      const dialog = await openDeleteConfirm();
      expect(await dialog.findByRole("heading", { name: "Delete 38 sessions from this device?" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Delete 38 sessions" })).toBeInTheDocument();
    });

    it("refreshes the device's count after its sessions are deleted", async () => {
      let served = device({ session_count: 12 });
      serve();
      server.use(
        http.get(DEVICES, () => HttpResponse.json([served])),
        http.delete(`${DEVICES}/:id/sessions`, () => {
          served = device({ session_count: 0 });
          return HttpResponse.json({ deleted: 12 });
        }),
      );
      renderDevices();
      const dialog = await openDeleteConfirm();
      await userEvent.click(dialog.getByRole("button", { name: "Delete 12 sessions" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await userEvent.click(screen.getByRole("button", { name: "More actions for Carol's MacBook Pro" }));
      await waitFor(() =>
        expect(screen.queryByRole("menuitem", { name: "Delete this device's sessions" })).not.toBeInTheDocument(),
      );
    });
  });

  it("blurs device names in presenter mode", async () => {
    act(() => setPromptsHidden(true));
    serve();
    renderDevices();
    expect(await screen.findByText("Carol's MacBook Pro", { selector: "h2 [aria-hidden]" })).toBeInTheDocument();
  });

  it("teaches the levels and how to add a computer", async () => {
    serve();
    renderDevices();
    expect(await screen.findByRole("table", { name: "What each level sends" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Add a computer" })).toBeInTheDocument();
  });

  it("says when there are no devices yet", async () => {
    serve([]);
    renderDevices();
    expect(await screen.findByRole("heading", { name: "No devices yet" })).toBeInTheDocument();
  });

  it("links the two tabs and counts the devices", async () => {
    serve([device(), device({ installation_id: "dev-2", name: "Box" })]);
    renderDevices();
    const tabs = await screen.findByRole("navigation", { name: "My sessions sections" });
    expect(within(tabs).getByRole("link", { name: "Sessions" })).toHaveAttribute("href", `/${SLUG}/sessions`);
    const devices = within(tabs).getByRole("link", { name: /Devices/ });
    expect(devices).toHaveAttribute("aria-current", "page");
    expect(await within(devices).findByText("2")).toBeInTheDocument();
  });
});

describe("Devices — rich capture", () => {
  const RICH_CAPTURE = { content_level: "rich", effective_content_level: "rich" } as const;

  function levelGroup(folder: string) {
    return screen.findByRole("group", { name: `What ${folder} sends` });
  }

  it("shows each folder's own level: an old mapping keeps its level, a new one arrives rich", async () => {
    serve(
      [device()],
      [
        mapping({ id: "old", origin: "explicit", content_level: "standard", capture: { content_level: "standard", effective_content_level: "standard" } }),
        mapping({ id: "new", origin: "auto_repo", root_path: "/home/operator/code/api", content_level: "rich", capture: RICH_CAPTURE }),
      ],
    );
    renderDevices();

    const old = await levelGroup("~/code/backplane");
    expect(within(old).getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true");
    const fresh = await levelGroup("~/code/api");
    expect(within(fresh).getByRole("button", { name: "Rich" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Captured as Full/)).not.toBeInTheDocument();
  });

  it("says a rich folder captures as Full on a Companion that predates rich capture", async () => {
    serve([device()], [mapping({ content_level: "rich", capture: { content_level: "rich", effective_content_level: "full", reason: "device_unsupported" } })]);
    renderDevices();

    const folders = await screen.findByRole("table", { name: "Folders sending to internal-projects" });
    expect(within(folders).getByText("Captured as Full until this computer's Companion is updated.")).toBeInTheDocument();
  });

  it("says a rich folder captures as Full while this Backplane has rich capture off", async () => {
    serve([device()], [mapping({ content_level: "rich", capture: { content_level: "rich", effective_content_level: "full", reason: "server_disabled" } })]);
    renderDevices();

    const folders = await screen.findByRole("table", { name: "Folders sending to internal-projects" });
    expect(within(folders).getByText("Captured as Full: rich capture is off on this Backplane.")).toBeInTheDocument();
  });

  it("reads a mapping from an older server, which reports no effective capture", async () => {
    serve([device()], [mapping({ content_level: "full" })]);
    renderDevices();

    expect(within(await levelGroup("~/code/backplane")).getByRole("button", { name: "Full" })).toHaveAttribute("aria-pressed", "true");
  });

  it("turns a folder rich", async () => {
    const calls = serve();
    renderDevices();

    await userEvent.click(within(await levelGroup("~/code/backplane")).getByRole("button", { name: "Rich" }));
    await waitFor(() => expect(calls.patches).toContainEqual({ url: `${DEVICES}/dev-mac/mappings/map-1`, body: { content_level: "rich" } }));
  });

  it("explains a refused rich level instead of a generic failure", async () => {
    serve();
    server.use(
      http.patch(`${DEVICES}/:id/mappings/:mappingId`, () =>
        HttpResponse.json(
          { detail: "Rich capture is not enabled on this Backplane", error_code: "rich_capture_unavailable", error_params: {}, context: null },
          { status: 409 },
        ),
      ),
    );
    renderDevices();

    await userEvent.click(within(await levelGroup("~/code/backplane")).getByRole("button", { name: "Rich" }));
    expect(await screen.findByText("Rich capture isn't enabled on this Backplane.")).toBeInTheDocument();
    expect(within(await levelGroup("~/code/backplane")).getByRole("button", { name: "Standard" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows Rich as unavailable where this Backplane has rich capture off", async () => {
    serve();
    stubAuthModes(true, { richCaptureEnabled: false });
    renderDevices();

    const level = await levelGroup("~/code/backplane");
    await waitFor(() => expect(within(level).getByRole("button", { name: "Rich" })).toBeDisabled());
    // Scoped to the levels panel: sonner keeps an earlier test's toast with the same words.
    const levels = screen.getByRole("table", { name: "What each level sends" }).closest("section") as HTMLElement;
    expect(within(levels).getByText("Rich capture isn't enabled on this Backplane.")).toBeInTheDocument();
  });

  for (const language of ["es", "pt-BR"]) {
    it(`names the rich level and its fallback in ${language}`, async () => {
      await act(() => i18n.changeLanguage(language));
      try {
        const t = i18n.getFixedT(language);
        serve([device()], [mapping({ content_level: "rich", capture: { content_level: "rich", effective_content_level: "full", reason: "server_disabled" } })]);
        renderDevices();

        const rich = t("sessions.rail.captured.levels.rich");
        const fallback = t("sessions.devices.folders.capture.server_disabled");
        expect(fallback).not.toBe(i18n.getFixedT("en")("sessions.devices.folders.capture.server_disabled"));
        expect(fallback).not.toMatch(/^sessions\./);
        expect(await screen.findByText(fallback)).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: rich }).length).toBeGreaterThan(0);
      } finally {
        await act(() => i18n.changeLanguage("en"));
      }
    });
  }

  it("teaches what Rich adds over Full", async () => {
    serve();
    renderDevices();

    const table = await screen.findByRole("table", { name: "What each level sends" });
    expect(within(table).getByRole("columnheader", { name: "Rich" })).toBeInTheDocument();
    const attachments = within(table).getByRole("row", { name: /Attached images and files/ });
    expect(within(attachments).getAllByRole("img", { name: "Sent" })).toHaveLength(1);
    expect(within(attachments).getAllByText("Not sent")).toHaveLength(3);
  });
});
