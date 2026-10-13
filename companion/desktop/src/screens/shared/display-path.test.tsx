// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen } from "@testing-library/react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";

import { resetDisplayPathsForTests, shownPath, useDisplayPath } from "./display-path";

function maskingIpc(calls: string[] = []) {
  mockIPC((command, payload) => {
    if (command !== "display_path") throw `unexpected command ${command}`;
    const path = (payload as { path: string }).path;
    calls.push(path);
    return path.replace(/^\/home\/tester/, "~");
  });
  return calls;
}

function Probe({ path }: { path: string | null }) {
  const shown = useDisplayPath(path);
  return <span data-testid="shown">{shown ?? "pending"}</span>;
}

beforeEach(() => resetDisplayPathsForTests());

describe("useDisplayPath", () => {
  it("is pending until Rust answers, then shows the masked path", async () => {
    maskingIpc();
    render(<Probe path="/home/tester/code/app" />);
    expect(screen.getByTestId("shown")).toHaveTextContent("pending");
    await act(async () => {});
    expect(screen.getByTestId("shown")).toHaveTextContent("~/code/app");
  });

  it("asks Rust once per path, however many rows show it", async () => {
    const calls = maskingIpc();
    render(
      <>
        <Probe path="/home/tester/code/app" />
        <Probe path="/home/tester/code/app" />
      </>,
    );
    await act(async () => {});
    render(<Probe path="/home/tester/code/app" />);
    await act(async () => {});
    expect(calls).toEqual(["/home/tester/code/app"]);
  });

  it("shows a cached path at once, with no pending frame", async () => {
    maskingIpc();
    await shownPath("/home/tester/code/app");
    render(<Probe path="/home/tester/code/app" />);
    expect(screen.getByTestId("shown")).toHaveTextContent("~/code/app");
  });

  it("caches nothing when the command is refused, and asks again on the next use", async () => {
    let refuse = true;
    const calls: string[] = [];
    mockIPC((_command, payload) => {
      calls.push((payload as { path: string }).path);
      if (refuse) throw "command display_path not allowed";
      return "~/code/app";
    });
    const first = render(<Probe path="/home/tester/code/app" />);
    await act(async () => {});
    expect(screen.getByTestId("shown")).toHaveTextContent("pending");
    first.unmount();

    refuse = false;
    render(<Probe path="/home/tester/code/app" />);
    await act(async () => {});
    expect(screen.getByTestId("shown")).toHaveTextContent("~/code/app");
    expect(calls).toHaveLength(2);
  });

  it("never shows the raw path when the command is refused", async () => {
    mockIPC(() => {
      throw "command display_path not allowed";
    });
    render(<Probe path="/home/tester/code/secret-client" />);
    await act(async () => {});
    expect(screen.getByTestId("shown")).toHaveTextContent("pending");
    expect(screen.getByTestId("shown")).not.toHaveTextContent("secret-client");
  });

  it("stays empty for no path, without asking Rust", async () => {
    const calls = maskingIpc();
    render(<Probe path={null} />);
    await act(async () => {});
    expect(screen.getByTestId("shown")).toHaveTextContent("pending");
    expect(calls).toEqual([]);
  });
});
