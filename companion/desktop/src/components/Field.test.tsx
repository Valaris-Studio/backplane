// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Field, Input } from "./Field";

describe("Field and Input", () => {
  it("labels the input and describes it with the message", () => {
    render(
      <Field label="Device name" message="1 to 80 characters. Press Esc to cancel.">
        <Input defaultValue="Ada’s MacBook Pro" />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Device name" });
    expect(input).toHaveAccessibleDescription("1 to 80 characters. Press Esc to cancel.");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("marks the input invalid and shows the message as an error", () => {
    render(
      <Field label="Device name" message="The name can’t be empty." tone="error">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Device name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    const message = screen.getByText("The name can’t be empty.").closest("[data-field-message]");
    expect(message).toHaveAttribute("data-tone", "error");
    expect(message?.querySelector("svg")).not.toBeNull();
  });

  it("shows a success message with a check", () => {
    render(
      <Field label="Server address" message="Found Backplane at this address." tone="ok">
        <Input type="url" />
      </Field>,
    );
    const message = screen.getByText("Found Backplane at this address.").closest("[data-field-message]");
    expect(message).toHaveAttribute("data-tone", "ok");
    expect(screen.getByRole("textbox", { name: "Server address" })).toHaveAttribute("aria-invalid", "false");
  });

  it("has no description when there is no message", () => {
    render(
      <Field label="New folder pattern">
        <Input />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "New folder pattern" })).not.toHaveAttribute("aria-describedby");
  });

  it("can keep its label visually hidden and still name the input", () => {
    render(
      <Field label="Search boards" labelHidden>
        <Input type="search" />
      </Field>,
    );
    expect(screen.getByRole("searchbox", { name: "Search boards" })).toBeInTheDocument();
    expect(screen.getByText("Search boards")).toHaveClass("sr-only");
  });

  it("works as a bare input outside a Field", async () => {
    render(<Input aria-label="Pattern" invalid />);
    const input = screen.getByRole("textbox", { name: "Pattern" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    await userEvent.type(input, "~/clients/**");
    expect(input).toHaveValue("~/clients/**");
  });
});

describe("Input Escape rule", () => {
  it("hands Escape to onEscape and marks the event handled", async () => {
    const onEscape = vi.fn();
    const seen: boolean[] = [];
    render(
      <div onKeyDown={(event) => seen.push(event.defaultPrevented)}>
        <Input aria-label="Name" onEscape={onEscape} />
      </div>,
    );
    screen.getByRole("textbox", { name: "Name" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(seen).toEqual([true]);
  });

  it("takes onEscape from its Field", async () => {
    const onEscape = vi.fn();
    render(
      <Field label="Device name" onEscape={onEscape}>
        <Input />
      </Field>,
    );
    screen.getByRole("textbox", { name: "Device name" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("leaves Escape alone when there is no onEscape", async () => {
    const seen: boolean[] = [];
    render(
      <div onKeyDown={(event) => seen.push(event.defaultPrevented)}>
        <Input aria-label="Name" />
      </div>,
    );
    screen.getByRole("textbox", { name: "Name" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(seen).toEqual([false]);
  });
});
