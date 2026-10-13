// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, StrictMode, useState } from "react";
import { describe, expect, it } from "vitest";

import { MotionProvider } from "../motion/MotionProvider";
import { AlertDialog } from "./AlertDialog";
import { Button, LinkButton } from "./Button";
import { SectionHead } from "./SectionHead";
import { Sheet } from "./Sheet";
import { StatePanel } from "./StatePanel";

describe("Button busy state", () => {
  const busyRegion = () => document.querySelector<HTMLElement>("[data-busy-announcer]");

  it("announces '<label>, working…' politely while loading and keeps its name", async () => {
    const { rerender } = render(<Button>Disconnect</Button>);
    expect(busyRegion()).toHaveAttribute("aria-live", "polite");
    expect(busyRegion()).toHaveClass("sr-only");
    rerender(<Button loading>Disconnect</Button>);
    const button = screen.getByRole("button", { name: "Disconnect" });
    expect(button).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(busyRegion()).toHaveTextContent("Disconnect, working…"));
    rerender(<Button>Disconnect</Button>);
    expect(busyRegion()).toHaveTextContent("");
  });

  it("announces nothing for a button that is not loading", async () => {
    render(<Button>Save</Button>);
    await act(async () => {});
    expect(busyRegion()?.textContent ?? "").toBe("");
  });

  it("announces the AlertDialog's running confirmation", async () => {
    render(
      <MotionProvider>
        <AlertDialog title="Disconnect this Mac?" confirmLabel="Disconnect" confirming onConfirm={() => {}} onCancel={() => {}}>
          <p>Capture stops.</p>
        </AlertDialog>
      </MotionProvider>,
    );
    expect(screen.getByRole("button", { name: "Disconnect" })).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(busyRegion()).toHaveTextContent("Disconnect, working…"));
  });

  it("still passes a forwarded ref to the button", () => {
    const forwarded = createRef<HTMLButtonElement>();
    render(<Button ref={forwarded}>Cancel</Button>);
    expect(forwarded.current).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("Button trailing icon", () => {
  it("renders the trailing icon after the label", () => {
    render(<Button trailingIcon="external">Open Backplane</Button>);
    const button = screen.getByRole("button", { name: "Open Backplane" });
    expect(button.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(button.firstChild?.textContent).toBe("Open Backplane");
  });

  it("keeps the trailing icon and shows the spinner in front while loading", () => {
    render(
      <Button trailingIcon="external" loading>
        Open Backplane
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Open Backplane" });
    expect(button.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(button.firstElementChild).not.toBe(button.lastElementChild);
  });

  it("LinkButton puts its icon after the label by default", () => {
    render(<LinkButton icon="external">Docs</LinkButton>);
    expect(screen.getByRole("button", { name: "Docs" }).lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});

describe("StatePanel fine print", () => {
  it("renders the fine print after the actions", () => {
    render(
      <StatePanel icon="pause" title="Paused from Backplane" actions={<Button>Open Backplane</Button>} finePrint="Your admin paused capture.">
        Nothing is captured.
      </StatePanel>,
    );
    const actions = screen.getByRole("button", { name: "Open Backplane" }).parentElement;
    const finePrint = screen.getByText("Your admin paused capture.");
    expect(actions?.compareDocumentPosition(finePrint)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(finePrint).toHaveClass("bp-panel-fine");
  });

  it("renders no fine print element without one", () => {
    const { container } = render(<StatePanel icon="pause" title="Paused" />);
    expect(container.querySelector(".bp-panel-fine")).toBeNull();
  });
});

describe("SectionHead focus", () => {
  it("makes the heading programmatically focusable through a ref", () => {
    const heading = createRef<HTMLHeadingElement>();
    render(<SectionHead title="Live now" headingRef={heading} />);
    act(() => heading.current?.focus());
    expect(screen.getByRole("heading", { name: "Live now" })).toHaveFocus();
    expect(heading.current).toHaveAttribute("tabindex", "-1");
  });

  it("takes an explicit tabIndex", () => {
    render(<SectionHead title="Live now" tabIndex={0} />);
    expect(screen.getByRole("heading", { name: "Live now" })).toHaveAttribute("tabindex", "0");
  });

  it("is not focusable by default", () => {
    render(<SectionHead title="Earlier" />);
    expect(screen.getByRole("heading", { name: "Earlier" })).not.toHaveAttribute("tabindex");
  });
});

function StrictSheet() {
  const [open, setOpen] = useState(false);
  return (
    <MotionProvider>
      <Button onClick={() => setOpen(true)}>Bind to board…</Button>
      {open ? (
        <Sheet title="Bind mobile-app" onClose={() => setOpen(false)}>
          <input aria-label="Search boards" />
        </Sheet>
      ) : null}
    </MotionProvider>
  );
}

function StrictDialog() {
  const [open, setOpen] = useState(false);
  return (
    <MotionProvider>
      <Button onClick={() => setOpen(true)}>Disconnect…</Button>
      {open ? (
        <AlertDialog title="Disconnect this Mac?" confirmLabel="Disconnect" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}>
          <p>Capture stops.</p>
        </AlertDialog>
      ) : null}
    </MotionProvider>
  );
}

describe("modal focus under StrictMode", () => {
  it("returns focus to the Sheet's opener on Escape", async () => {
    render(
      <StrictMode>
        <StrictSheet />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Bind to board…" });
    opener.focus();
    await userEvent.click(opener);
    expect(opener).not.toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("returns focus to the AlertDialog's opener on Escape", async () => {
    render(
      <StrictMode>
        <StrictDialog />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Disconnect…" });
    opener.focus();
    await userEvent.click(opener);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });
});
