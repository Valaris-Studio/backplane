// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Escape layering for a diagram opened for editing inside a modal host: the
// first Escape belongs to the open Mermaid source and returns it to the
// preview; only the next one reaches the host's close guard. Real TipTap
// editor, real Sheet/Dialog focus traps and the real unsaved-changes guard.
// Only mermaid's renderer is stubbed: jsdom cannot lay out SVG (see
// RichTextEditorImpl.mermaid.test.tsx).
import { useState } from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import {
  act,
  renderWithProviders,
  screen,
  stubReducedMotion,
  userEvent,
  waitFor,
  within,
} from "@/test/test-utils";
import en from "@/i18n/locales/en.json";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { UnsavedChangesPrompt } from "@/components/ui/unsaved-changes-prompt";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import RichTextEditorImpl from "../RichTextEditorImpl";

const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async () => ({ svg: "<svg data-testid='diagram'></svg>" })),
}));

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

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

// Settled open/close states synchronously; the exit tween otherwise gates the
// host's unmount on a GSAP onComplete jsdom's ticker makes unreliable.
beforeEach(() => stubReducedMotion(true));
afterEach(() => stubReducedMotion(false));

const HOST_TITLE = "Mermaid host";
const HOST_INPUT_LABEL = "Host title";
const DIAGRAM = "graph TD\n  A[Start] --> B[Finish]";
const OTHER_DIAGRAM = "graph LR\n  C[Left] --> D[Right]";
const CODE = "const answer = 42;";

const codeBlock = (language: string, text: string) => ({
  type: "codeBlock",
  attrs: { language },
  content: [{ type: "text", text }],
});

// Ends in an empty paragraph, as TipTap's trailing-node rule canonicalizes it,
// so focusing the editor is not itself a document change.
const NESTED_DOC = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
    codeBlock("mermaid", DIAGRAM),
    codeBlock("mermaid", OTHER_DIAGRAM),
    codeBlock("ts", CODE),
    { type: "paragraph" },
  ],
});

const SINGLE_DIAGRAM_DOC = JSON.stringify({
  type: "doc",
  content: [codeBlock("mermaid", DIAGRAM), { type: "paragraph" }],
});

type Surface = "sheet" | "dialog";

function GuardedHost({
  surface,
  dirty,
  onClose,
  onChange,
}: {
  surface: Surface;
  dirty: boolean;
  onClose: () => void;
  onChange: (json: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const guard = useUnsavedChangesGuard({
    isDirty: dirty,
    onClose: () => {
      onClose();
      setOpen(false);
    },
    onSave: () => {},
    canSave: true,
  });
  const body = (
    <>
      <input aria-label={HOST_INPUT_LABEL} defaultValue="Card" />
      <RichTextEditorImpl content={NESTED_DOC} onChange={onChange} />
    </>
  );

  return (
    <>
      {surface === "sheet" ? (
        <Sheet open={open} onOpenChange={guard.handleOpenChange}>
          <SheetContent>
            <SheetTitle>{HOST_TITLE}</SheetTitle>
            {body}
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={open} onOpenChange={guard.handleOpenChange}>
          <DialogContent>
            <DialogTitle>{HOST_TITLE}</DialogTitle>
            {body}
          </DialogContent>
        </Dialog>
      )}
      <UnsavedChangesPrompt
        open={guard.guardOpen}
        canSave={guard.canSave}
        onSave={guard.saveAndClose}
        onDiscard={guard.closeAnyway}
        onKeepEditing={guard.dismissGuard}
      />
    </>
  );
}

type EditorRoot = HTMLElement & { editor?: Editor };

function diagramBlocks(scope: ParentNode) {
  return Array.from(scope.querySelectorAll<HTMLElement>("[data-mermaid-block]"));
}

function sourceOf(block: HTMLElement) {
  const source = block.querySelector<HTMLElement>("[data-mermaid-source]");
  if (!source) throw new Error("mermaid block has no source element");
  return source;
}

function showsSource(block: HTMLElement) {
  return sourceOf(block).getAttribute("aria-hidden") !== "true";
}

function showsRenderedPreview(block: HTMLElement) {
  return block.querySelector("[data-mermaid-preview] svg") !== null;
}

async function mountedEditor(scope: ParentNode, expectedDiagrams: number) {
  await waitFor(() => expect(scope.querySelector(".ProseMirror")).not.toBeNull());
  const root = scope.querySelector(".ProseMirror") as EditorRoot;
  const editor = root.editor;
  if (!editor) throw new Error("editor not mounted");
  await waitFor(() => {
    const blocks = diagramBlocks(scope);
    expect(blocks).toHaveLength(expectedDiagrams);
    expect(blocks.every(showsRenderedPreview)).toBe(true);
  });
  return { root, editor };
}

async function mountHost(surface: Surface, dirty: boolean) {
  const onClose = vi.fn();
  const onChange = vi.fn();
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(
    <GuardedHost surface={surface} dirty={dirty} onClose={onClose} onChange={onChange} />,
  );
  const host = await screen.findByRole("dialog", { name: HOST_TITLE });
  const { root, editor } = await mountedEditor(host, 2);
  return { user, host, root, editor, onClose, onChange };
}

async function openDiagramSource(
  user: ReturnType<typeof userEvent.setup>,
  block: HTMLElement,
  root: HTMLElement,
) {
  await user.click(within(block).getByRole("button", { name: en.editor.mermaidEdit }));
  await waitFor(() => expect(showsSource(block)).toBe(true));
  expect(block.querySelector("[data-mermaid-preview]")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(root));
}

function editorSnapshot(editor: Editor, onChange: ReturnType<typeof vi.fn>) {
  return {
    doc: JSON.stringify(editor.getJSON()),
    selection: editor.state.selection.toJSON(),
    changeCount: onChange.mock.calls.length,
  };
}

describe("RichTextEditorImpl — Escape while editing a Mermaid source inside a modal host", () => {
  it("Sheet: the first Escape returns the diagram to its preview, the next one closes the clean host", async () => {
    const { user, host, root, editor, onClose, onChange } = await mountHost("sheet", false);
    const [edited, untouched] = diagramBlocks(host);
    await openDiagramSource(user, edited!, root);
    const before = editorSnapshot(editor, onChange);

    await user.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(showsSource(edited!)).toBe(false));
    expect(showsRenderedPreview(edited!)).toBe(true);
    expect(screen.getByRole("dialog", { name: HOST_TITLE })).toBe(host);
    expect(sourceOf(edited!).textContent).toBe(DIAGRAM);
    expect(editorSnapshot(editor, onChange)).toEqual(before);
    expect(document.activeElement).toBe(root);
    expect(showsSource(untouched!)).toBe(false);
    expect(showsRenderedPreview(untouched!)).toBe(true);
    expect(sourceOf(untouched!).textContent).toBe(OTHER_DIAGRAM);
    expect(host.querySelector("pre:not([data-mermaid-source]) code")?.textContent).toBe(CODE);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: HOST_TITLE })).toBeNull());
  });

  it("Dialog: the first Escape never raises the dirty host's prompt; the next one does, and the prompt owns focus", async () => {
    const { user, host, root, editor, onClose, onChange } = await mountHost("dialog", true);
    const [edited] = diagramBlocks(host);
    await openDiagramSource(user, edited!, root);
    const before = editorSnapshot(editor, onChange);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(showsSource(edited!)).toBe(false));
    expect(screen.queryByTestId("unsaved-changes-prompt")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(showsRenderedPreview(edited!)).toBe(true);
    expect(sourceOf(edited!).textContent).toBe(DIAGRAM);
    expect(editorSnapshot(editor, onChange)).toEqual(before);
    expect(document.activeElement).toBe(root);

    await user.keyboard("{Escape}");

    const prompt = await screen.findByRole("alertdialog", { name: en.unsavedChanges.title });
    await waitFor(() => expect(prompt.contains(document.activeElement)).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: HOST_TITLE })).toBe(host);
    expect(showsSource(edited!)).toBe(false);
    expect(sourceOf(edited!).textContent).toBe(DIAGRAM);
    expect(editorSnapshot(editor, onChange)).toEqual(before);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("unsaved-changes-prompt")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: HOST_TITLE })).toBe(host);
    await waitFor(() => expect(document.activeElement).toBe(root));
  });

  it("an editor Escape with no diagram source open still reaches the host on the first press", async () => {
    const { user, root, editor, onClose } = await mountHost("sheet", false);
    act(() => {
      editor.commands.focus("start");
    });
    await waitFor(() => expect(document.activeElement).toBe(root));

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("an Escape from a host control outside the editor is not taken by the open diagram source", async () => {
    const { user, host, root, onClose } = await mountHost("sheet", false);
    const [edited] = diagramBlocks(host);
    await openDiagramSource(user, edited!, root);
    const hostInput = within(host).getByRole("textbox", { name: HOST_INPUT_LABEL });
    act(() => hostInput.focus());

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a pointer press outside the diagram still returns it to the preview without touching the host", async () => {
    const { user, host, root, onClose } = await mountHost("sheet", false);
    const [edited] = diagramBlocks(host);
    await openDiagramSource(user, edited!, root);

    await user.click(within(host).getByRole("textbox", { name: HOST_INPUT_LABEL }));

    await waitFor(() => expect(showsSource(edited!)).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an Escape that ends an IME composition leaves the diagram source open", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = renderWithProviders(
      <RichTextEditorImpl content={SINGLE_DIAGRAM_DOC} onChange={() => {}} />,
    );
    const { root } = await mountedEditor(container, 1);
    const [edited] = diagramBlocks(container);
    await openDiagramSource(user, edited!, root);

    // What Chromium dispatches for Escape while an IME owns the keystroke.
    fireEvent.keyDown(root, { key: "Escape", keyCode: 229, isComposing: true });

    expect(showsSource(edited!)).toBe(true);

    await user.keyboard("{Escape}");

    await waitFor(() => expect(showsSource(edited!)).toBe(false));
  });
});
