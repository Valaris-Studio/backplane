// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplatePublishAction } from "../components/LoopTemplatePublishAction";
import { findingTab, findingsFrom } from "../lib/publish-findings";

// Card 0a65a907 — the header Publish action.
//
// Publish is the ONLY thing that bumps a version (spec §5.1 F9). A 422 comes
// back as validator findings whose `field` is a dotted path into the template
// content; each one links to the tab that owns it so the operator lands on the
// offending editor instead of hunting for it.

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const PUBLISH_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}/publish`;

let bodies: Record<string, unknown>[];

function servePublish(responder: () => Response) {
  server.use(
    http.post(PUBLISH_URL, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return responder();
    }),
  );
}

function renderAction(props: Partial<Parameters<typeof LoopTemplatePublishAction>[0]> = {}) {
  const onNavigateToTab = vi.fn();
  const utils = renderWithProviders(
    <LoopTemplatePublishAction
      slug={SLUG}
      templateRef={REF}
      version={3}
      canPublish
      onNavigateToTab={onNavigateToTab}
      {...props}
    />,
  );
  return { ...utils, onNavigateToTab };
}

beforeEach(() => {
  bodies = [];
});

describe("findingTab", () => {
  it.each([
    ["system_prompt", "prompts"],
    ["loop_prompt", "prompts"],
    ["slots.RUN_LABEL", "slots"],
    ["slot_values.REPO_URL", "slots"],
    ["tools", "rails"],
    ["derived_rails.completion_query", "rails"],
    ["setup_contract.required_column_types", "contract"],
  ])("routes %s to the %s tab", (field, tab) => {
    expect(findingTab(field)).toBe(tab);
  });

  it("falls back to the prompts tab for an unrecognised path", () => {
    // A new backend finding kind must still be clickable rather than inert.
    expect(findingTab("something_new.deep.path")).toBe("prompts");
  });
});

describe("findingsFrom", () => {
  it("reads findings out of a structured detail", () => {
    const findings = findingsFrom([
      { code: "unused_slot", field: "slots.X", message: "unused" },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe("slots.X");
  });

  it("reads findings out of the interceptor's stringified detail", () => {
    // The shared axios interceptor JSON-stringifies a non-string `detail` into
    // `message`, so the same list can arrive either way.
    const findings = findingsFrom(
      JSON.stringify([
        { code: "unused_slot", field: "slots.X", message: "unused" },
      ]),
    );
    expect(findings).toHaveLength(1);
  });

  // Asserted here rather than through the component: react-query's onError
  // swallows a throw, so a crash on these inputs is INVISIBLE at the UI level
  // and only a direct call can prove the guard holds.
  it.each([
    ["a plain string", "expected_version must be an integer"],
    ["null", null],
    ["undefined", undefined],
    ["an object", { detail: "nope" }],
    ["a number", 42],
  ])("returns an empty list for %s instead of throwing", (_label, input) => {
    expect(findingsFrom(input)).toEqual([]);
  });

  it("drops entries that carry no field path", () => {
    // A finding with no `field` has no tab to link to; rendering it would
    // produce a dead button.
    expect(findingsFrom([{ code: "x", message: "no field" }, null])).toEqual(
      [],
    );
  });
});

describe("LoopTemplatePublishAction", () => {
  it("sends the note and expected_version", async () => {
    const user = userEvent.setup();
    servePublish(() => HttpResponse.json({ version: 4 }));
    renderAction();

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.type(
      screen.getByTestId("loop-template-publish-note"),
      "tightened the stop rule",
    );
    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.note).toBe("tightened the stop rule");
    expect(bodies[0]?.expected_version).toBe(3);
  });

  it("renders each 422 finding and navigates to the tab that owns it", async () => {
    const user = userEvent.setup();
    servePublish(() =>
      HttpResponse.json(
        {
          detail: [
            {
              code: "uncatalogued_slot",
              field: "loop_prompt",
              message: "<<NOPE>> is not in the slot catalog",
            },
            {
              code: "off_switch_missing",
              field: "tools",
              message: "the off switch tool is not granted",
            },
          ],
        },
        { status: 422 },
      ),
    );
    const { onNavigateToTab } = renderAction();

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    const findings = await screen.findAllByTestId(/^loop-template-finding-/);
    expect(findings).toHaveLength(2);
    expect(screen.getByText(/<<NOPE>> is not in the slot catalog/)).toBeInTheDocument();

    await user.click(screen.getByTestId("loop-template-finding-0"));
    expect(onNavigateToTab).toHaveBeenCalledWith("prompts");

    await user.click(screen.getByTestId("loop-template-finding-1"));
    expect(onNavigateToTab).toHaveBeenCalledWith("rails");
  });

  it("shows the conflict banner on a 409 instead of the findings list", async () => {
    const user = userEvent.setup();
    servePublish(() =>
      HttpResponse.json(
        { detail: "Version moved", error_code: "stale_version" },
        { status: 409 },
      ),
    );
    renderAction();

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    expect(
      await screen.findByTestId("loop-template-publish-conflict"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-finding-0"),
    ).not.toBeInTheDocument();
  });

  it("is absent entirely when the caller cannot publish", () => {
    renderAction({ canPublish: false });

    expect(
      screen.queryByTestId("loop-template-publish-open"),
    ).not.toBeInTheDocument();
  });

  it("closes the dialog and reports success when publish succeeds", async () => {
    const user = userEvent.setup();
    servePublish(() => HttpResponse.json({ version: 4 }));
    const onPublished = vi.fn();
    renderAction({ onPublished });

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.queryByTestId("loop-template-publish-confirm"),
      ).not.toBeInTheDocument(),
    );
  });

  it("clears the previous findings the moment a retry starts", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    let attempt = 0;
    servePublish(() => {
      attempt += 1;
      if (attempt === 1) {
        return HttpResponse.json(
          {
            detail: [
              { code: "unused_slot", field: "slots.X", message: "unused" },
            ],
          },
          { status: 422 },
        );
      }
      // Hold the second attempt open: the findings must be gone WHILE it is
      // in flight, not merely once it succeeds.
      return new Promise<Response>((resolve) => {
        release = () => resolve(HttpResponse.json({ version: 4 }));
      }) as unknown as Response;
    });
    renderAction();

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.click(screen.getByTestId("loop-template-publish-confirm"));
    expect(
      await screen.findByTestId("loop-template-finding-0"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("loop-template-finding-0"),
      ).not.toBeInTheDocument(),
    );

    release?.();
  });

  it("ignores a 422 body that is not a findings array", async () => {
    const user = userEvent.setup();
    servePublish(() =>
      // FastAPI's own request-validation 422 has this shape; rendering it as
      // findings would print "[object Object]" rows with no field to link.
      HttpResponse.json({ detail: "expected_version must be an integer" }, {
        status: 422,
      }),
    );
    renderAction();

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(
      screen.queryByTestId("loop-template-finding-0"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("loop-template-findings")).not.toBeInTheDocument();
  });

  it("clears stale findings when the operator retries", async () => {
    const user = userEvent.setup();
    let attempt = 0;
    servePublish(() => {
      attempt += 1;
      return attempt === 1
        ? HttpResponse.json(
            {
              detail: [
                { code: "unused_slot", field: "slots.X", message: "unused" },
              ],
            },
            { status: 422 },
          )
        : HttpResponse.json({ version: 4 });
    });
    renderAction();

    await user.click(screen.getByTestId("loop-template-publish-open"));
    await user.click(screen.getByTestId("loop-template-publish-confirm"));
    expect(
      await screen.findByTestId("loop-template-finding-0"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("loop-template-publish-confirm"));

    // A stale findings list next to a successful publish would tell the
    // operator their template is still broken when it is not.
    await waitFor(() =>
      expect(
        screen.queryByTestId("loop-template-finding-0"),
      ).not.toBeInTheDocument(),
    );
  });
});
