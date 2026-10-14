// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { MotionProvider } from "../motion/MotionProvider";
import { REDUCED_MOTION_QUERY, stubMatchMedia } from "../test/media";
import { Button } from "./Button";
import { Sheet } from "./Sheet";

function Harness({ onClose }: { onClose?: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  return (
    <MotionProvider>
      <div className="relative">
        <Button onClick={() => setOpen(true)}>Bind to board…</Button>
        {open ? (
          <Sheet
            title="Bind mobile-app"
            onClose={close}
            initialFocusRef={searchRef}
            footer={
              <>
                <Button onClick={close}>Cancel</Button>
                <Button variant="primary">Bind</Button>
              </>
            }
          >
            <input ref={searchRef} aria-label="Search boards" />
          </Sheet>
        ) : null}
      </div>
    </MotionProvider>
  );
}

async function openSheet(onClose?: () => void) {
  render(<Harness onClose={onClose} />);
  const opener = screen.getByRole("button", { name: "Bind to board…" });
  opener.focus();
  await userEvent.click(opener);
  return opener;
}

describe("Sheet", () => {
  it("is a modal dialog named by its title", async () => {
    await openSheet();
    const sheet = screen.getByRole("dialog", { name: "Bind mobile-app" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
  });

  it("focuses the requested element when it opens", async () => {
    await openSheet();
    expect(screen.getByRole("textbox", { name: "Search boards" })).toHaveFocus();
  });

  it("focuses its first control when no initial focus is given", async () => {
    render(
      <MotionProvider>
        <Sheet title="Pick" onClose={() => {}}>
          <Button>First</Button>
        </Sheet>
      </MotionProvider>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("keeps Tab inside the sheet in both directions", async () => {
    await openSheet();
    screen.getByRole("button", { name: "Bind" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Bind" })).toHaveFocus();
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const onClose = vi.fn();
    const opener = await openSheet(onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  });

  it("closes from the scrim and the close button", async () => {
    const onClose = vi.fn();
    await openSheet(onClose);
    await userEvent.click(screen.getByTestId("sheet-scrim"));
    expect(onClose).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Bind to board…" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close when a click lands inside the sheet", async () => {
    const onClose = vi.fn();
    await openSheet(onClose);
    await userEvent.click(screen.getByRole("dialog", { name: "Bind mobile-app" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("slides in from below with full motion", () => {
    stubMatchMedia(null);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Bind to board…" }));
    expect(screen.getByRole("dialog").style.transform).toContain("translateY");
  });

  it("only fades under reduced motion: no transform at all", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    await openSheet();
    const transform = screen.getByRole("dialog").style.transform;
    expect(transform === "" || transform === "none").toBe(true);
  });
});

describe("Sheet, review fixes", () => {
  it("does not close when something inside already handled Escape", async () => {
    const onClose = vi.fn();
    render(
      <MotionProvider>
        <Sheet title="Pick" onClose={onClose}>
          <input
            aria-label="Inner"
            onKeyDown={(event) => {
              if (event.key === "Escape") event.preventDefault();
            }}
          />
        </Sheet>
      </MotionProvider>,
    );
    screen.getByRole("textbox", { name: "Inner" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns focus to the opener's replacement, found by data-focus-key, when the opener re-rendered away", async () => {
    function Remounting() {
      const [open, setOpen] = useState(false);
      const [generation, setGeneration] = useState(0);
      return (
        <MotionProvider>
          <Button key={generation} data-focus-key="bind" onClick={() => setOpen(true)}>
            Bind to board…
          </Button>
          {open ? (
            <Sheet
              title="Bind"
              onClose={() => {
                setGeneration((value) => value + 1);
                setOpen(false);
              }}
            >
              <Button>Inside</Button>
            </Sheet>
          ) : null}
        </MotionProvider>
      );
    }
    render(<Remounting />);
    const opener = screen.getByRole("button", { name: "Bind to board…" });
    opener.focus();
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    const replacement = screen.getByRole("button", { name: "Bind to board…" });
    expect(replacement).not.toBe(opener);
    expect(replacement).toHaveFocus();
  });

  it("can't be dismissed while it isn't dismissible: no Close, and Escape and the scrim do nothing", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    const onClose = vi.fn();
    render(
      <MotionProvider>
        <Sheet title="Switch server" onClose={onClose} dismissible={false}>
          <p>Switching…</p>
        </Sheet>
      </MotionProvider>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByTestId("sheet-scrim"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
