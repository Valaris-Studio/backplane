// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { setPlatformForTests } from "../platform/platform";
import { PrivacyLevelControl } from "./PrivacyLevelControl";
import type { PrivacyLevel } from "./privacy-levels";

function Controlled({ initial = "standard", onChange }: { initial?: PrivacyLevel; onChange?: (level: PrivacyLevel) => void }) {
  const [level, setLevel] = useState<PrivacyLevel>(initial);
  return (
    <PrivacyLevelControl richOffer="offered"
      value={level}
      onValueChange={(next) => {
        setLevel(next);
        onChange?.(next);
      }}
    />
  );
}

const HELP = {
  metadata:
    "Activity only. Sends counts, timing, cost, tool and model names, the repository, branch and folder name. Prompts, commands and output stay on this Mac.",
  standard: "Adds your prompts, commands and tool arguments. Your first prompt titles the session. Tool output and the agent’s replies stay on this Mac.",
  full: "Adds tool output, the agent’s replies and file diffs. Each output is cut at 16 KB, and some agents don’t report theirs. Only you can read sessions in Backplane.",
} as const;

const ALWAYS =
  "At every level, your computer and user names are removed, paths become relative to the project (or start with ~), and text that looks like a key or password is masked. Masking matches patterns, so it can miss some.";

const detailToggle = (label: string) => screen.getByRole("button", { name: `What ${label} sends, in detail` });

describe("PrivacyLevelControl", () => {
  it("offers Metadata, Standard, Full and Rich as a radiogroup named What’s sent", () => {
    render(<Controlled />);
    expect(screen.getByRole("radiogroup", { name: "What’s sent" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "What’s stored" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Metadata", "Standard", "Full", "Rich"]);
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAttribute("aria-checked", "true");
  });

  it("explains each level with what it sends", () => {
    const { rerender } = render(<PrivacyLevelControl richOffer="offered" value="metadata" onValueChange={() => {}} />);
    expect(screen.getByTestId("privacy-help")).toHaveTextContent(HELP.metadata);
    rerender(<PrivacyLevelControl richOffer="offered" value="standard" onValueChange={() => {}} />);
    expect(screen.getByTestId("privacy-help")).toHaveTextContent(HELP.standard);
    rerender(<PrivacyLevelControl richOffer="offered" value="full" onValueChange={() => {}} />);
    expect(screen.getByTestId("privacy-help")).toHaveTextContent(HELP.full);
  });

  it("says Standard sends prompts, commands and tool arguments", () => {
    render(<PrivacyLevelControl richOffer="offered" value="standard" onValueChange={() => {}} />);
    expect(screen.getByTestId("privacy-help")).toHaveTextContent("prompts, commands and tool arguments");
  });

  it("says Metadata sends the folder name and never claims tool names stay behind", () => {
    render(<PrivacyLevelControl richOffer="offered" value="metadata" onValueChange={() => {}} />);
    const help = screen.getByTestId("privacy-help");
    expect(help).toHaveTextContent("folder name");
    expect(help).not.toHaveTextContent(/No\b.*tool names/);
  });

  it("names the device the copy talks about on each platform", () => {
    setPlatformForTests("windows");
    render(<PrivacyLevelControl richOffer="offered" value="standard" onValueChange={() => {}} />);
    expect(screen.getByTestId("privacy-help")).toHaveTextContent("stay on this PC.");
  });

  it("says Full is readable only by you (the corrected DK-0 copy)", () => {
    render(<PrivacyLevelControl richOffer="offered" value="full" onValueChange={() => {}} />);
    const help = screen.getByTestId("privacy-help");
    expect(help).toHaveTextContent("Only you can read sessions in Backplane.");
    expect(help).not.toHaveTextContent(/people who can open this board/i);
  });

  it("announces the explanation politely when the level changes", async () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    screen.getByRole("radio", { name: "Standard" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("full");
    expect(screen.getByTestId("privacy-help")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveAttribute("data-level", "full");
  });

  it("does not change level while disabled", async () => {
    const onChange = vi.fn();
    render(<PrivacyLevelControl richOffer="offered" value="metadata" disabled onValueChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Full" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("PrivacyLevelControl, in detail", () => {
  it("keeps the detail collapsed until asked", () => {
    render(<Controlled />);
    const toggle = detailToggle("Standard");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Sent" })).not.toBeInTheDocument();
  });

  it("lists what Standard sends and what stays on the device, with its cap and the always note", async () => {
    render(<Controlled />);
    await userEvent.click(detailToggle("Standard"));
    expect(detailToggle("Standard")).toHaveAttribute("aria-expanded", "true");
    const sent = screen.getByRole("list", { name: "Sent" });
    expect(within(sent).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Everything in Metadata",
      "Your prompts",
      "Commands and tool arguments, including file paths",
      "The working folder’s path inside the project",
      "Error messages",
    ]);
    const kept = screen.getByRole("list", { name: "Stays on this Mac" });
    expect(within(kept).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Tool and command output", "The agent’s replies", "File diffs and file contents that commands write"]);
    expect(screen.getByText("Each prompt, command or argument is cut at 4 KB.")).toBeInTheDocument();
    expect(screen.getByText(ALWAYS)).toBeInTheDocument();
  });

  it("follows the selected level while open", async () => {
    render(<Controlled initial="metadata" />);
    await userEvent.click(detailToggle("Metadata"));
    expect(within(screen.getByRole("list", { name: "Sent" })).getByText("The working folder’s name, like “api”")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Stays on this Mac" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Your prompts, so sessions have no title",
      "Commands, tool arguments and file paths",
      "Error messages",
      "Tool output, the agent’s replies and diffs",
    ]);
    expect(screen.getByText("Withheld text is sent only as its size and a fingerprint, so repeats can be matched.")).toBeInTheDocument();

    screen.getByRole("radio", { name: "Metadata" }).focus();
    await userEvent.keyboard("{End}");
    expect(detailToggle("Rich")).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Sent" })).getByText("Complete tool output and replies, beyond 16 KB")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Stays on this Mac" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Files outside the project folder",
    ]);

    await userEvent.keyboard("{ArrowLeft}");
    expect(detailToggle("Full")).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("list", { name: "Sent" })).getByText("Tool and command output, up to 16 KB each")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Stays on this Mac" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Images and other binary data",
    ]);
  });

  it("states the always note at every level", async () => {
    for (const level of ["metadata", "standard", "full", "rich"] as const) {
      const { unmount } = render(<Controlled initial={level} />);
      await userEvent.click(screen.getByRole("button", { name: /sends, in detail$/ }));
      expect(screen.getByText(ALWAYS)).toBeInTheDocument();
      unmount();
    }
  });

  it("opens and closes from the keyboard", async () => {
    render(<Controlled />);
    detailToggle("Standard").focus();
    await userEvent.keyboard("{Enter}");
    expect(detailToggle("Standard")).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard(" ");
    expect(detailToggle("Standard")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("PrivacyLevelControl, review fixes", () => {
  it("describes the radiogroup with the help text", () => {
    render(<PrivacyLevelControl richOffer="offered" value="full" onValueChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "What’s sent" })).toHaveAccessibleDescription(HELP.full);
  });

  it("shows Rich but skips it with the arrows where this Backplane doesn't offer it", async () => {
    const onChange = vi.fn();
    render(
      <PrivacyLevelControl richOffer="not_offered" value="full" onValueChange={onChange} />,
    );
    expect(screen.getByRole("radio", { name: "Rich" })).toHaveAttribute("aria-disabled", "true");
    screen.getByRole("radio", { name: "Full" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("metadata");
    await userEvent.click(screen.getByRole("radio", { name: "Rich" }));
    expect(onChange).not.toHaveBeenCalledWith("rich");
  });

  it("keeps the tab stop on a checked level that can't be chosen any more", async () => {
    render(<PrivacyLevelControl richOffer="not_offered" value="rich" onValueChange={() => {}} />);
    const rich = screen.getByRole("radio", { name: "Rich" });
    expect(rich).toHaveAttribute("aria-checked", "true");
    expect(rich).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Metadata" })).toHaveAttribute("tabindex", "-1");
    await userEvent.tab();
    expect(rich).toHaveFocus();
  });

  it("steps from a checked level that can't be chosen to the nearest one that can", async () => {
    const onChange = vi.fn();
    render(<PrivacyLevelControl richOffer="not_offered" value="rich" onValueChange={onChange} />);
    screen.getByRole("radio", { name: "Rich" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenCalledWith("full");
    expect(screen.getByRole("radio", { name: "Full" })).toHaveFocus();
  });
});
