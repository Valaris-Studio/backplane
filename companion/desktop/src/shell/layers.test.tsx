// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../components/Button";
import { MotionProvider } from "../motion/MotionProvider";
import { REDUCED_MOTION_QUERY, stubMatchMedia } from "../test/media";
import { TOAST_DURATION_MS, confirmDialog, layersStore, useDialog, useSheet, useToast, type DialogHandle } from "./layers";
import { LayersHost } from "./LayersHost";

function Probe() {
  const toast = useToast();
  const sheet = useSheet();
  const dialog = useDialog();
  const [answer, setAnswer] = useState<string>("none");
  return (
    <>
      <Button onClick={() => toast.show("Capture resumed.")}>Toast</Button>
      <Button onClick={() => toast.show("Couldn’t pause capture.", { tone: "error" })}>Error toast</Button>
      <Button
        onClick={() =>
          sheet.open({
            title: "Bind mobile-app",
            render: ({ close }) => <Button onClick={close}>Done</Button>,
          })
        }
      >
        Open sheet
      </Button>
      <Button onClick={() => sheet.open({ title: "Second sheet", render: () => <p>second</p> })}>Open second sheet</Button>
      <Button
        onClick={async () => {
          const confirmed = await dialog.confirm({
            title: "Remove Companion?",
            body: <p>Sessions already uploaded stay in Backplane.</p>,
            confirmLabel: "Remove",
          });
          setAnswer(String(confirmed));
        }}
      >
        Remove…
      </Button>
      <span data-testid="answer">{answer}</span>
    </>
  );
}

function renderLayers() {
  render(
    <MotionProvider>
      <div data-testid="app-content">
        <Probe />
      </div>
      <LayersHost />
    </MotionProvider>,
  );
}

describe("useToast", () => {
  it("shows one message at a time as a status, replacing the previous one", async () => {
    renderLayers();
    await userEvent.click(screen.getByRole("button", { name: "Toast" }));
    expect(screen.getByText("Capture resumed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Error toast" }));
    await vi.waitFor(() => expect(document.querySelectorAll("[data-toast]")).toHaveLength(1));
    expect(screen.getByText("Couldn’t pause capture.").closest("[data-toast]")).toHaveAttribute("data-tone", "error");
  });

  it("dismisses itself after the toast duration", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderLayers();
      await userEvent.click(screen.getByRole("button", { name: "Toast" }));
      expect(screen.getByText("Capture resumed.")).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(TOAST_DURATION_MS + 500);
      });
      await vi.waitFor(() => expect(screen.queryByText("Capture resumed.")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useSheet", () => {
  it("opens one sheet and closes on Escape with focus returned", async () => {
    renderLayers();
    const opener = screen.getByRole("button", { name: "Open sheet" });
    opener.focus();
    await userEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Bind mobile-app" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(opener).toHaveFocus();
  });

  it("lets the content close its own sheet", async () => {
    stubMatchMedia(REDUCED_MOTION_QUERY);
    renderLayers();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Bind mobile-app" })).toBeNull());
  });

  it("replaces an open sheet rather than stacking a second one", async () => {
    renderLayers();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    act(() => {
      screen.getByRole("button", { name: "Open second sheet", hidden: true }).click();
    });
    await vi.waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "Second sheet" })).toBeInTheDocument();
  });
});

describe("useDialog", () => {
  it("resolves true when the destructive action is confirmed", async () => {
    renderLayers();
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(screen.getByTestId("answer")).toHaveTextContent("true"));
  });

  it("resolves false on Cancel and on Escape, returning focus to the opener", async () => {
    renderLayers();
    const opener = screen.getByRole("button", { name: "Remove…" });
    opener.focus();
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.getByTestId("answer")).toHaveTextContent("false"));
    expect(opener).toHaveFocus();
  });
});

describe("layers, review fixes", () => {
  it("keeps empty status and alert live regions mounted before any toast", () => {
    renderLayers();
    const politeRegion = document.querySelector('[data-toast-region="status"]');
    const alertRegion = document.querySelector('[data-toast-region="alert"]');
    expect(politeRegion).toHaveAttribute("role", "status");
    expect(alertRegion).toHaveAttribute("role", "alert");
    expect(politeRegion).toBeEmptyDOMElement();
    expect(alertRegion).toBeEmptyDOMElement();
  });

  it("puts success toasts in the status region and error toasts in the alert region", async () => {
    renderLayers();
    await userEvent.click(screen.getByRole("button", { name: "Toast" }));
    expect(document.querySelector('[data-toast-region="status"]')).toHaveTextContent("Capture resumed.");
    await userEvent.click(screen.getByRole("button", { name: "Error toast" }));
    expect(document.querySelector('[data-toast-region="alert"]')).toHaveTextContent("Couldn’t pause capture.");
  });

  it("makes an open sheet inert while a dialog sits on top of it", async () => {
    renderLayers();
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    const sheet = screen.getByRole("dialog", { name: "Bind mobile-app" });
    expect(sheet.closest("[inert]")).toBeNull();
    act(() => {
      void confirmDialog({ title: "Remove Companion?", body: <p>Gone.</p>, confirmLabel: "Remove" });
    });
    expect(screen.getByRole("dialog", { name: "Bind mobile-app", hidden: true }).closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("alertdialog").closest("[inert]")).toBeNull();
  });
});

describe("async confirm", () => {
  function AsyncProbe({ action }: { action: () => Promise<void> }) {
    const dialog = useDialog();
    const [answer, setAnswer] = useState("none");
    return (
      <>
        <Button
          onClick={async () => setAnswer(String(await dialog.confirm({ title: "Disconnect this Mac?", body: <p>Capture stops.</p>, confirmLabel: "Disconnect", onConfirm: action })))}
        >
          Disconnect…
        </Button>
        <span data-testid="answer">{answer}</span>
      </>
    );
  }

  function renderAsync(action: () => Promise<void>) {
    render(
      <MotionProvider>
        <AsyncProbe action={action} />
        <LayersHost />
      </MotionProvider>,
    );
  }

  it("keeps the dialog open with a busy confirm button until the action settles, then resolves true", async () => {
    let finish: () => void = () => {};
    renderAsync(() => new Promise<void>((resolve) => (finish = resolve)));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect…" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => finish());
    await vi.waitFor(() => expect(screen.getByTestId("answer")).toHaveTextContent("true"));
  });

  it("ignores Escape while the action runs", async () => {
    renderAsync(() => new Promise<void>(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect…" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByTestId("answer")).toHaveTextContent("none");
  });

  it("shows an inline error and stays open when the action fails, and can still be cancelled", async () => {
    renderAsync(() => Promise.reject({ kind: "api", status: 502, code: "server_unreachable", message: "Backplane didn’t answer.", detail: null }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect…" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const error = await screen.findByText("Backplane didn’t answer.");
    expect(error.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).not.toHaveAttribute("aria-busy");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.getByTestId("answer")).toHaveTextContent("false"));
  });

  it("falls back to a generic message for a failure without one", async () => {
    renderAsync(() => Promise.reject(42));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect…" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("That didn’t work. Try again.")).toBeInTheDocument();
  });
});

describe("dialog.update, scoped to its own dialog", () => {
  function RelabelProbe({ action }: { action: (dialog: DialogHandle) => Promise<void> }) {
    const dialog = useDialog();
    return (
      <Button onClick={() => void dialog.confirm({ title: "Already bound elsewhere", body: <p>Rebind?</p>, confirmLabel: "Delete and bind", onConfirm: action })}>
        Bind…
      </Button>
    );
  }

  function renderRelabel(action: (dialog: DialogHandle) => Promise<void>) {
    render(
      <MotionProvider>
        <RelabelProbe action={action} />
        <LayersHost />
      </MotionProvider>,
    );
  }

  it("relabels its dialog's confirm button and keeps the inline error of a failed action", async () => {
    renderRelabel(async (dialog) => {
      dialog.update({ confirmLabel: "Bind here" });
      throw new Error("The old binding was removed, but binding here failed.");
    });
    await userEvent.click(screen.getByRole("button", { name: "Bind…" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete and bind" }));
    expect(await screen.findByText("The old binding was removed, but binding here failed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bind here" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete and bind" })).not.toBeInTheDocument();
  });

  it("leaves a newer dialog alone when an older one's handle updates late", async () => {
    let finishOld: () => void = () => {};
    let oldHandle: DialogHandle | null = null;
    renderRelabel(
      (dialog) =>
        new Promise<void>((resolve) => {
          oldHandle = dialog;
          finishOld = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Bind…" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete and bind" }));
    act(() => settleDialogForTests());
    act(() => void confirmDialog({ title: "Disconnect this Mac?", body: <p>Capture stops.</p>, confirmLabel: "Disconnect" }));
    act(() => (oldHandle as DialogHandle | null)?.update({ confirmLabel: "Bind here" }));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bind here" })).toBeNull();
    finishOld();
  });
});

// A busy dialog ignores Cancel; drop it as a replacement would, without settling its action.
function settleDialogForTests() {
  const { dialog } = layersStore.get();
  if (!dialog) return;
  layersStore.set({ ...layersStore.get(), dialog: null });
  dialog.resolve(false);
}
