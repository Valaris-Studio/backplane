// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, act } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import {
  LoopTemplatePreviewPanel,
  exampleValues,
} from "../components/LoopTemplatePreviewPanel";
import type { DraftSlot } from "../lib/draft-content";

// Card 199bf1ec (AC5) — the two preview modes.
//
// Both endpoints accept ONLY `slot_values` (`LoopTemplatePreviewRequest` is
// `extra="forbid"`), so what makes the preview match the author's screen is the
// autosave FLUSH before the request — not draft prompts in the body. These
// tests pin that ordering, because a preview of the pre-edit copy would be
// wrong in a way nothing else catches.

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const BOARD_ID = "99999999-8888-7777-6666-555555555555";
const WS_PREVIEW = `/api/workspaces/${SLUG}/loop-templates/${REF}/preview`;
const BOARD_PREVIEW = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/loop-templates/${REF}/preview`;
const BOARDS_URL = `/api/workspaces/${SLUG}/boards`;

const RUNNER_VARS = ["Workspace", "BoardID"];

const SLOTS: DraftSlot[] = [
  { name: "RUN_LABEL", kind: "scalar", example: "loop-8" },
  { name: "NO_EXAMPLE", kind: "scalar" },
];

let wsBodies: Record<string, unknown>[];
let boardBodies: Record<string, unknown>[];
let calls: string[];

function previewResponse(over: Record<string, unknown> = {}) {
  return {
    template: { ref: REF, version: 2 },
    system_prompt: "rendered system",
    loop_prompt: "rendered loop",
    loop_prompt_with_tools_manifest: "rendered loop + tools",
    tools: ["search_cards"],
    rails: {},
    findings: [],
    missing_required: [],
    used_values: {},
    ...over,
  };
}

function serve(over: Record<string, unknown> = {}) {
  server.use(
    http.get(BOARDS_URL, () =>
      HttpResponse.json([{ id: BOARD_ID, name: "Backplane", slug: "bp" }]),
    ),
    http.post(WS_PREVIEW, async ({ request }) => {
      calls.push("workspace");
      wsBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(previewResponse(over));
    }),
    http.post(BOARD_PREVIEW, async ({ request }) => {
      calls.push("board");
      boardBodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(previewResponse(over));
    }),
  );
}

function renderPanel(
  props: Partial<Parameters<typeof LoopTemplatePreviewPanel>[0]> = {},
) {
  return renderWithProviders(
    <LoopTemplatePreviewPanel
      slug={SLUG}
      templateRef={REF}
      slots={SLOTS}
      runnerVars={RUNNER_VARS}
      {...props}
    />,
  );
}

// userEvent.setup() installs a clipboard stub on `navigator` per test and the
// non-secure-context case DELETES it; without this restore that deletion leaks
// forward and every later userEvent.setup() throws mid-interaction.
const realClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);
const realExecCommandDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "execCommand",
);
const realScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

function restore(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

beforeEach(() => {
  wsBodies = [];
  boardBodies = [];
  calls = [];
  // jsdom does not implement scrollIntoView — it THROWS rather than no-opping,
  // so every test that reaches a rendered result needs it defined. The
  // component deliberately calls it unguarded: a runtime typeof check would
  // hide a real regression in the browser.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  restore(navigator, "clipboard", realClipboardDescriptor);
  restore(document, "execCommand", realExecCommandDescriptor);
  restore(Element.prototype, "scrollIntoView", realScrollIntoViewDescriptor);
});

describe("exampleValues", () => {
  it("sends only slots that actually carry an example", () => {
    // An empty example would render as a literal empty string and read as a
    // deliberate blank rather than "not provided".
    expect(exampleValues(SLOTS)).toEqual({ RUN_LABEL: "loop-8" });
  });
});

describe("LoopTemplatePreviewPanel — with example values", () => {
  it("posts SlotSpec examples to the board-less endpoint", async () => {
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));

    await waitFor(() => expect(wsBodies).toHaveLength(1));
    expect(wsBodies[0]).toEqual({ slot_values: { RUN_LABEL: "loop-8" } });
    expect(calls).toEqual(["workspace"]);
  });

  it("renders the runner view, not the authored loop prompt", async () => {
    // The agent reads loop_prompt_with_tools_manifest; showing bare loop_prompt
    // would hide the block that tells it which tools it may call.
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));

    const pane = await screen.findByTestId("loop-template-preview-loop");
    expect(pane).toHaveTextContent("rendered loop + tools");
    expect(
      await screen.findByTestId("loop-template-preview-system"),
    ).toHaveTextContent("rendered system");
  });
});

describe("LoopTemplatePreviewPanel — on board", () => {
  it("posts to the board-scoped endpoint once a board is chosen", async () => {
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-mode-board"));
    await user.click(await screen.findByTestId("loop-template-preview-board"));
    await user.click(await screen.findByRole("option", { name: "Backplane" }));
    await user.click(screen.getByTestId("loop-template-preview-run"));

    await waitFor(() => expect(boardBodies).toHaveLength(1));
    expect(calls).toEqual(["board"]);
    // Values come from the board's autofill, so the client sends none.
    expect(boardBodies[0]).toEqual({ slot_values: {} });
  });

  it("cannot run before a board is chosen", async () => {
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-mode-board"));
    expect(screen.getByTestId("loop-template-preview-run")).toBeDisabled();
  });

  it("labels each autofilled value with its source", async () => {
    serve({
      used_values: { RUN_LABEL: { value: "loop-8", source: "board.name" } },
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-mode-board"));
    await user.click(await screen.findByTestId("loop-template-preview-board"));
    await user.click(await screen.findByRole("option", { name: "Backplane" }));
    await user.click(screen.getByTestId("loop-template-preview-run"));

    expect(
      await screen.findByTestId("loop-template-preview-source-RUN_LABEL"),
    ).toHaveTextContent("board.name");
  });
});

describe("LoopTemplatePreviewPanel — findings and copy", () => {
  it("lists findings without blocking the render", async () => {
    serve({
      findings: [
        { code: "unused_slot", field: "slots.X", message: "never referenced" },
      ],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));

    const findings = await screen.findByTestId(
      "loop-template-preview-findings",
    );
    expect(findings).toHaveTextContent("slots.X");
    expect(findings).toHaveTextContent("never referenced");
    // A preview that hid its output on findings would defeat its own purpose.
    expect(
      await screen.findByTestId("loop-template-preview-loop"),
    ).toHaveTextContent("rendered loop + tools");
  });

  it("copies the runner view to the clipboard", async () => {
    serve();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    // AFTER setup(): userEvent installs its own clipboard stub, so defining
    // ours first would be silently overwritten and the assertion would test
    // userEvent's stub instead of the component.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await user.click(
      await screen.findByTestId("loop-template-preview-copy-loop"),
    );

    expect(writeText).toHaveBeenCalledWith("rendered loop + tools");
  });

  it("copies each pane's OWN text, not one shared payload", async () => {
    // One button for two panes meant the system prompt could not be copied at
    // all — the pane the operator most often needs to paste into a runner.
    serve();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await user.click(
      await screen.findByTestId("loop-template-preview-copy-system"),
    );
    await user.click(
      await screen.findByTestId("loop-template-preview-copy-loop"),
    );

    expect(writeText.mock.calls.map((call) => call[0])).toEqual([
      "rendered system",
      "rendered loop + tools",
    ]);
  });

  it("falls back to execCommand when navigator.clipboard is undefined", async () => {
    // A self-hosted instance on plain HTTP has no navigator.clipboard at all;
    // the raw writeText call threw an unhandled rejection inside the handler.
    serve();
    const user = userEvent.setup();
    // AFTER setup() — userEvent installs its own stub, so the property has to
    // be DELETED here or this asserts against userEvent's stub, not the
    // non-secure-context path the component must survive.
    Reflect.deleteProperty(navigator, "clipboard");
    const execCommand = vi.fn().mockReturnValue(true);
    // jsdom does not implement execCommand; an unstubbed call returns
    // undefined, which the util reads as failure and toasts.
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await user.click(
      await screen.findByTestId("loop-template-preview-copy-loop"),
    );

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(
      await screen.findByTestId("loop-template-preview-copy-loop"),
    ).toHaveTextContent("Copied");
  });

  it("reverts the copied confirmation to the idle label", async () => {
    // It latched true forever: the button read "Copied" for the rest of the
    // session, so a second copy gave no feedback at all.
    serve();
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    const button = await screen.findByTestId("loop-template-preview-copy-loop");

    // Fake timers go in only AFTER the msw round-trip above — installed at the
    // top of the test they stall the fetch and it times out before copying —
    // but BEFORE the click, or the reset timeout is scheduled on real timers
    // and advancing fake ones can never fire it.
    vi.useFakeTimers();
    try {
      await act(async () => {
        button.click();
      });
      expect(button).toHaveTextContent("Copied");

      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(button).toHaveTextContent("Copy rendered");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LoopTemplatePreviewPanel — pending, error and focus", () => {
  it("shows a pending region instead of a stale result while rendering", async () => {
    // The Run button merely disabled; a slow render left the screen unchanged
    // and the operator could not tell the click had registered.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(WS_PREVIEW, async () => {
        await gate;
        return HttpResponse.json(previewResponse());
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));

    try {
      expect(
        await screen.findByTestId("loop-template-preview-pending"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("loop-template-preview-result"),
      ).not.toBeInTheDocument();

    } finally {
      // An unreleased gate keeps the msw handler pending and every later test
      // in the file times out behind it.
      release?.();
    }

    expect(
      await screen.findByTestId("loop-template-preview-result"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("loop-template-preview-pending"),
    ).not.toBeInTheDocument();
  });

  it("hides the PREVIOUS result while a re-run is in flight", async () => {
    // The stale-result risk is real but the component does not guard it —
    // useMutation clears `data` when a new mutation starts, so this pins the
    // LIBRARY behaviour the panel leans on. If a future refactor keeps the last
    // result across runs (useMutation options, or a cached local copy), this
    // goes red and the explicit guard has to come back.
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await screen.findByTestId("loop-template-preview-result");

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post(WS_PREVIEW, async () => {
        await gate;
        return HttpResponse.json(previewResponse());
      }),
    );

    await user.click(screen.getByTestId("loop-template-preview-run"));

    try {
      await screen.findByTestId("loop-template-preview-pending");
      expect(
        screen.queryByTestId("loop-template-preview-result"),
      ).not.toBeInTheDocument();
    } finally {
      release?.();
    }

    await screen.findByTestId("loop-template-preview-result");
  });

  it("scrolls once per RESULT, not once per render", async () => {
    // A dependency-less effect re-scrolls on every unrelated state change —
    // switching preview mode would yank the viewport back down.
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await screen.findByTestId("loop-template-preview-result");

    const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >;
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));

    // A re-render that produces no new result must not scroll again.
    await user.click(screen.getByTestId("loop-template-preview-mode-board"));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("renders the server's detail when the preview request fails", async () => {
    // A 4xx preview was indistinguishable from never having clicked Run.
    server.use(
      http.post(WS_PREVIEW, () =>
        HttpResponse.json({ detail: "slot RUN_LABEL is not defined" }, {
          status: 422,
        }),
      ),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));

    const alert = await screen.findByTestId("loop-template-preview-error");
    expect(alert).toHaveTextContent("slot RUN_LABEL is not defined");
    expect(alert).toHaveAttribute("role", "alert");
  });

  it("clears the error once a later run succeeds", async () => {
    server.use(
      http.post(WS_PREVIEW, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await screen.findByTestId("loop-template-preview-error");

    serve();
    await user.click(screen.getByTestId("loop-template-preview-run"));

    await screen.findByTestId("loop-template-preview-result");
    expect(
      screen.queryByTestId("loop-template-preview-error"),
    ).not.toBeInTheDocument();
  });

  it("scrolls the result into view exactly once per successful run", async () => {
    // The panes cap at max-h-72 under the mode controls, so on a short viewport
    // the rendered prompt lands below the fold and reads as "nothing happened".
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    serve();
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await screen.findByTestId("loop-template-preview-result");

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("does not scroll when the run fails", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    server.use(
      http.post(WS_PREVIEW, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("loop-template-preview-run"));
    await screen.findByTestId("loop-template-preview-error");

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("LoopTemplatePreviewPanel — draft freshness", () => {
  it("flushes pending autosave BEFORE requesting the preview", async () => {
    // The server renders its stored copy, so an un-flushed draft would preview
    // the prompt as it was several keystrokes ago.
    serve();
    const order: string[] = [];
    const onBeforePreview = vi.fn(async () => {
      order.push("flush");
    });
    server.use(
      http.post(WS_PREVIEW, async () => {
        order.push("preview");
        return HttpResponse.json(previewResponse());
      }),
    );

    const user = userEvent.setup();
    renderPanel({ onBeforePreview });

    await user.click(screen.getByTestId("loop-template-preview-run"));

    await waitFor(() => expect(order).toEqual(["flush", "preview"]));
  });
});
