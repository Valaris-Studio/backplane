// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins card 067b9093 (sticky formatting toolbar) at the surface level: the
// definitions page's <main> is not the CSS scrollport (the WINDOW scrolls),
// so a TopBar offset on a page-sticky toolbar never engages. Instead each
// definitions editor owns a bounded internal scroller (max-h + overflow-y),
// so the toolbar sticks at the editor shell's default `top-0` — no
// toolbarClassName override needed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import type { RichTextEditorProps } from "@/components/shared/RichTextEditor";

const capturedEditorProps: RichTextEditorProps[] = [];

// RichTextEditor pulls in TipTap; stub it to a plain textarea and capture the
// props each surface passes (pattern: NoteEditor.layout.test.tsx).
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: (props: RichTextEditorProps) => {
    capturedEditorProps.push(props);
    return <textarea data-testid="rte" defaultValue={props.content} />;
  },
}));

import { ScopeSection } from "../ScopeSection";
import { DecisionsSection } from "../DecisionsSection";

beforeEach(() => {
  capturedEditorProps.length = 0;
});

describe("definitions sections — bounded editor scroller, toolbar sticks at top-0", () => {
  it("ScopeSection gives the editor a bounded scroller and no toolbar offset", () => {
    renderWithProviders(
      <ScopeSection value="<p>scope</p>" onChange={vi.fn()} workspaceSlug="acme" />,
    );

    expect(capturedEditorProps).toHaveLength(1);
    const props = capturedEditorProps[0]!;
    expect(props.toolbarClassName).toBeUndefined();
    expect(props.className).toContain("min-h-[220px]");
    expect(props.className).toContain("max-h-[70vh]");
    expect(props.className).toContain("overflow-y-auto");
  });

  it("DecisionsSection gives each rationale editor a bounded scroller and no toolbar offset", () => {
    renderWithProviders(
      <DecisionsSection
        items={[
          { decision: "Ship it", rationale: "<p>because</p>" },
          { decision: "Skip it", rationale: "<p>why not</p>" },
        ]}
        onChange={vi.fn()}
        workspaceSlug="acme"
      />,
    );

    expect(capturedEditorProps).toHaveLength(2);
    for (const props of capturedEditorProps) {
      expect(props.toolbarClassName).toBeUndefined();
      expect(props.className).toContain("max-h-[70vh]");
      expect(props.className).toContain("overflow-y-auto");
    }
  });
});
