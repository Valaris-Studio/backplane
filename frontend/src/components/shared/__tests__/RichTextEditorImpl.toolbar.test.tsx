// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins card 067b9093 (sticky formatting toolbar): jsdom computes no layout, so
// sticky positioning cannot be asserted behaviorally — these are CLASS-CONTRACT
// tests (house precedent: PromptHighlightPreview.test.tsx). The toolbar must be
// a real role="toolbar" landmark carrying `sticky top-0 z-10 rounded-t-[inherit]
// bg-background/95 backdrop-blur`, and `toolbarClassName` must be appended AFTER
// the defaults through cn() so tailwind-merge lets a surface's top offset win.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import RichTextEditor from "@/components/shared/RichTextEditorImpl";

// prosemirror-view probes DOM geometry APIs jsdom doesn't implement.
beforeAll(() => {
  const rect = {
    top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Range.prototype.getBoundingClientRect = () => rect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

const PARAGRAPH_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
});

async function waitForEditorMount(container: HTMLElement) {
  // immediatelyRender: false — the editor mounts in an effect.
  await waitFor(() => {
    expect(container.querySelector(".tiptap-editor")).not.toBeNull();
  });
}

describe("RichTextEditor — sticky formatting toolbar class contract", () => {
  it("exposes the toolbar as role=toolbar with the sticky class set", async () => {
    const { container } = renderWithProviders(
      <RichTextEditor content={PARAGRAPH_DOC} onChange={vi.fn()} editable />,
    );
    await waitForEditorMount(container);

    const toolbar = screen.getByRole("toolbar", { name: "Formatting toolbar" });
    for (const cls of [
      "sticky",
      "top-0",
      "z-10",
      "rounded-t-[inherit]",
      "bg-background/95",
      "backdrop-blur",
    ]) {
      expect(toolbar.classList.contains(cls), `toolbar should carry "${cls}"`).toBe(true);
    }
  });

  it("toolbarClassName top offset overrides the default top-0 (appended after defaults)", async () => {
    const { container } = renderWithProviders(
      <RichTextEditor
        content={PARAGRAPH_DOC}
        onChange={vi.fn()}
        editable
        toolbarClassName="top-[var(--topbar-height)]"
      />,
    );
    await waitForEditorMount(container);

    const toolbar = screen.getByRole("toolbar", { name: "Formatting toolbar" });
    expect(toolbar.classList.contains("top-[var(--topbar-height)]")).toBe(true);
    // tailwind-merge must drop the conflicting default — this pins the cn()
    // argument order (defaults first, override last).
    expect(toolbar.classList.contains("top-0")).toBe(false);
    // sanity: still sticky.
    expect(toolbar.classList.contains("sticky")).toBe(true);
  });

  it("renders no toolbar landmark when editable is false", async () => {
    const { container } = renderWithProviders(
      <RichTextEditor content={PARAGRAPH_DOC} onChange={vi.fn()} editable={false} />,
    );
    await waitForEditorMount(container);

    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
