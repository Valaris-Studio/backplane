// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, IconButton, LinkButton } from "./Button";

describe("Button", () => {
  it("is a plain type=button with the default variant and md size", () => {
    render(<Button>Check now</Button>);
    const button = screen.getByRole("button", { name: "Check now" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("data-variant", "default");
    expect(button).toHaveAttribute("data-size", "md");
    expect(button).not.toHaveAttribute("data-block");
  });

  it("carries the variant, size and block layout it is given", () => {
    render(
      <Button variant="ghost-danger" size="lg" block>
        Disconnect…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Disconnect…" });
    expect(button).toHaveAttribute("data-variant", "ghost-danger");
    expect(button).toHaveAttribute("data-size", "lg");
    expect(button).toHaveAttribute("data-block", "true");
  });

  it("calls onClick when pressed", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Bind</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Bind" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("ignores presses while disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Bind
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Bind" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows a spinner, marks itself busy and ignores presses while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Checking…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Checking…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("[data-spinner]")).not.toBeNull();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("submits forms only when asked to", () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });
});

describe("IconButton", () => {
  it("is named by its label and shows it as a tooltip", () => {
    render(<IconButton icon="gear" label="Settings" />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button).toHaveAttribute("title", "Settings");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("can show a tooltip that differs from its name", () => {
    render(<IconButton icon="pause" label="Pause capture" tooltip="Paused from Backplane" disabled />);
    const button = screen.getByRole("button", { name: "Pause capture" });
    expect(button).toHaveAttribute("title", "Paused from Backplane");
    expect(button).toBeDisabled();
  });
});

describe("LinkButton", () => {
  it("renders a trailing icon after its text", () => {
    render(<LinkButton icon="external">Open in Backplane</LinkButton>);
    const button = screen.getByRole("button", { name: "Open in Backplane" });
    expect(button.lastElementChild?.tagName.toLowerCase()).toBe("svg");
  });

  it("renders a leading icon before its text when asked", () => {
    render(
      <LinkButton icon="plus" iconPosition="start">
        Add folder…
      </LinkButton>,
    );
    const button = screen.getByRole("button", { name: "Add folder…" });
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});
