// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateSharingTab } from "../components/LoopTemplateSharingTab";

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const BASE = `/api/workspaces/${SLUG}/loop-templates`;
const DETAIL_URL = `${BASE}/${REF}`;
const LINT_URL = `${BASE}/${REF}/lint`;
const IMPORT_URL = `${BASE}/import`;

const adminState = { current: { role: "admin" as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return { ...actual, useNavigate: () => navigateSpy };
});

const DETAIL = {
  id: REF,
  slug: "coding-loop",
  source: "workspace",
  name: "Coding Loop",
  version: 3,
  is_system: false,
  is_draft: false,
  profile: {},
  content: { system_prompt: "You are…", loop_prompt: "Do…" },
  lineage: null,
  updated_at: "2026-08-16T10:00:00Z",
};

/** A leak finding as the backend emits it: {code, match, line, hint}. */
const LEAK = {
  code: "org_repo",
  match: "Valaris-Studio/valaris-intern",
  line: 4,
  hint: "Org/repo names are repo-specific; consider a slot.",
};

function serveDetail(findings: unknown[] = []) {
  server.use(
    http.get(DETAIL_URL, () => HttpResponse.json(DETAIL)),
    http.post(LINT_URL, () => HttpResponse.json({ findings })),
  );
}

function renderTab() {
  return renderWithProviders(
    <LoopTemplateSharingTab slug={SLUG} templateRef={REF} />,
  );
}

function bundleFile(slug = "imported-loop") {
  const bundle = {
    schema_version: 1,
    entity_type: "loop_template",
    data: { slug, content: { system_prompt: "x" } },
  };
  return new File([JSON.stringify(bundle)], `${slug}.loop-template.json`, {
    type: "application/json",
  });
}

/** The dry-run preview body, in the shape the backend actually returns. */
function previewBody(over: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    dry_run: true,
    action: "created",
    slug: "imported-loop",
    findings: [],
    diff_summary: [],
    leak_findings: [],
    template_id: null,
    ...over,
  };
}

beforeEach(() => {
  adminState.current.role = "admin";
  navigateSpy.mockReset();
});

describe("LoopTemplateSharingTab — export", () => {
  it("shows the repo-facts warning and the leak-lint findings", async () => {
    serveDetail([LEAK]);
    renderTab();

    expect(
      await screen.findByTestId("loop-template-sharing-warning"),
    ).toBeInTheDocument();

    const finding = await screen.findByTestId("sharing-leak-finding-0");
    expect(finding).toHaveTextContent(LEAK.match);
    // The hint is server copy relayed verbatim — deliberately unlike any
    // local string so a hard-coded fallback could not satisfy this.
    expect(finding).toHaveTextContent(LEAK.hint);
  });

  it("exports with the backend's attachment filename <slug>.loop-template.json", async () => {
    serveDetail();
    renderTab();

    const button = await screen.findByTestId("loop-template-sharing-export");
    expect(button).toHaveAttribute(
      "data-export-endpoint",
      `/workspaces/${SLUG}/loop-templates/${REF}/export`,
    );
    expect(button).toHaveAttribute(
      "data-export-filename",
      "coding-loop.loop-template.json",
    );
  });

  it("renders no findings list when the template is clean", async () => {
    serveDetail([]);
    renderTab();

    await screen.findByTestId("loop-template-sharing-export");
    expect(
      screen.queryByTestId("sharing-leak-finding-0"),
    ).not.toBeInTheDocument();
  });
});

describe("LoopTemplateSharingTab — import", () => {
  // Devops UX round 2 (#6): the file picker used to be a bare native input
  // with no button affordance. The visible control is now a real Button that
  // forwards to the hidden input.
  it("renders a button-styled file chooser that opens the hidden input", async () => {
    serveDetail();
    renderTab();

    const chooser = await screen.findByTestId(
      "loop-template-sharing-choose-file",
    );
    expect(chooser.tagName).toBe("BUTTON");
    expect(chooser).toHaveTextContent(/choose file/i);

    const input = screen.getByTestId("loop-template-sharing-file");
    expect(input).toHaveClass("hidden");
    const forwarded = vi
      .spyOn(input as HTMLInputElement, "click")
      .mockImplementation(() => {});
    await userEvent.click(chooser);
    expect(forwarded).toHaveBeenCalled();
  });

  it("posts dry_run=true on file select and renders the preview", async () => {
    serveDetail();
    const seen: string[] = [];
    server.use(
      http.post(IMPORT_URL, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("dry_run") ?? "");
        return HttpResponse.json(
          previewBody({ diff_summary: ["loop_prompt"] }),
        );
      }),
    );
    renderTab();

    const input = await screen.findByTestId("loop-template-sharing-file");
    await userEvent.upload(input, bundleFile());

    const preview = await screen.findByTestId("loop-template-sharing-preview");
    expect(preview).toHaveTextContent("imported-loop");
    expect(seen).toEqual(["true"]);
    // `action` picks the sentence; the backend has no created/updated counters.
    // Pinned against the `updated` copy so swapping the branch fails here.
    const action = screen.getByTestId("loop-template-sharing-preview-action");
    expect(action).toHaveTextContent(/create/i);
    expect(action).not.toHaveTextContent(/existing/i);
    expect(
      screen.getByTestId("loop-template-sharing-preview-diff"),
    ).toHaveTextContent("loop_prompt");
  });

  it("names the existing template when the action is an update", async () => {
    serveDetail();
    server.use(
      http.post(IMPORT_URL, () =>
        HttpResponse.json(previewBody({ action: "updated" })),
      ),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      bundleFile(),
    );

    const action = await screen.findByTestId(
      "loop-template-sharing-preview-action",
    );
    expect(action).toHaveTextContent(/existing/i);
    expect(action).toHaveTextContent("imported-loop");
  });

  it("sends the parsed bundle as a JSON body, not multipart", async () => {
    serveDetail();
    let contentType: string | null = null;
    let body: unknown = null;
    server.use(
      http.post(IMPORT_URL, async ({ request }) => {
        contentType = request.headers.get("content-type");
        body = await request.json();
        return HttpResponse.json(previewBody());
      }),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      bundleFile(),
    );

    await screen.findByTestId("loop-template-sharing-preview");
    expect(contentType).toContain("application/json");
    expect(body).toMatchObject({
      entity_type: "loop_template",
      data: { slug: "imported-loop" },
    });
  });

  it("Confirm posts dry_run=false and navigates to the created draft", async () => {
    serveDetail();
    const seen: string[] = [];
    server.use(
      http.post(IMPORT_URL, ({ request }) => {
        const dry = new URL(request.url).searchParams.get("dry_run") ?? "";
        seen.push(dry);
        return HttpResponse.json(
          previewBody(
            dry === "false"
              ? { dry_run: false, template_id: "new-template-id" }
              : {},
          ),
        );
      }),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      bundleFile(),
    );
    await userEvent.click(
      await screen.findByTestId("loop-template-sharing-confirm"),
    );

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        `/${SLUG}/runner/loops/new-template-id/profile`,
      );
    });
    expect(seen).toEqual(["true", "false"]);
  });

  it("renders a 400 envelope-guard error inline", async () => {
    serveDetail();
    server.use(
      http.post(IMPORT_URL, () =>
        HttpResponse.json(
          {
            detail:
              "expected entity_type 'loop_template', got 'pipeline_bundle'",
            error_code: "bad_request",
          },
          { status: 400 },
        ),
      ),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      bundleFile(),
    );

    const error = await screen.findByTestId("loop-template-sharing-error");
    expect(error).toHaveTextContent(/pipeline_bundle/);
    expect(
      screen.queryByTestId("loop-template-sharing-confirm"),
    ).not.toBeInTheDocument();
  });

  it("renders 422 validation findings inline on confirm", async () => {
    serveDetail();
    server.use(
      http.post(IMPORT_URL, ({ request }) => {
        const dry = new URL(request.url).searchParams.get("dry_run");
        if (dry === "true") return HttpResponse.json(previewBody());
        return HttpResponse.json(
          {
            detail: [
              {
                code: "uncatalogued_slot",
                field: "slots.REPO_URL",
                message: "slot REPO_URL is not catalogued",
              },
            ],
            error_code: "validation_error",
          },
          { status: 422 },
        );
      }),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      bundleFile(),
    );
    await userEvent.click(
      await screen.findByTestId("loop-template-sharing-confirm"),
    );

    const error = await screen.findByTestId("loop-template-sharing-error");
    expect(error).toHaveTextContent("slots.REPO_URL");
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("shows an unparseable file as an inline error without calling the API", async () => {
    serveDetail();
    let called = false;
    server.use(
      http.post(IMPORT_URL, () => {
        called = true;
        return HttpResponse.json(previewBody());
      }),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      new File(["{not json"], "broken.json", { type: "application/json" }),
    );

    await screen.findByTestId("loop-template-sharing-error");
    expect(called).toBe(false);
  });
});

describe("LoopTemplateSharingTab — gating", () => {
  it("hides every import control from a non-admin but keeps export", async () => {
    adminState.current.role = "member";
    serveDetail([LEAK]);
    renderTab();

    expect(
      await screen.findByTestId("loop-template-sharing-export"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("sharing-leak-finding-0")).toBeVisible();
    expect(
      screen.queryByTestId("loop-template-sharing-file"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-sharing-import"),
    ).not.toBeInTheDocument();
  });

  it("relays a 403 agent-caller message from the server", async () => {
    serveDetail();
    server.use(
      http.post(IMPORT_URL, () =>
        HttpResponse.json(
          {
            detail: "agent callers may not import templates",
            error_code: "forbidden",
          },
          { status: 403 },
        ),
      ),
    );
    renderTab();

    await userEvent.upload(
      await screen.findByTestId("loop-template-sharing-file"),
      bundleFile(),
    );

    expect(
      await screen.findByTestId("loop-template-sharing-error"),
    ).toHaveTextContent("agent callers may not import templates");
  });
});
