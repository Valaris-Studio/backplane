// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { PostPRReviewEditor } from "../PostPRReviewEditor";

describe("PostPRReviewEditor", () => {
  it("renders all three fields empty by default", () => {
    renderWithProviders(
      <PostPRReviewEditor params={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText(/decision/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/body from/i)).toHaveValue("");
    expect(screen.getByLabelText(/mode/i)).toBeInTheDocument();
  });

  it("renders populated values", () => {
    renderWithProviders(
      <PostPRReviewEditor
        params={{
          decision: "approve",
          body_from: "llm.summary",
          mode: "github",
        }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/decision/i).textContent).toMatch(/approve/i);
    expect(screen.getByLabelText(/body from/i)).toHaveValue("llm.summary");
    expect(screen.getByLabelText(/mode/i).textContent).toMatch(/github/i);
  });

  it("decision listbox shows exactly the three backend enum values", async () => {
    renderWithProviders(
      <PostPRReviewEditor params={{}} onChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByLabelText(/decision/i));
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    const texts = options.map((o) => o.textContent ?? "");
    expect(texts.some((t) => /approve/i.test(t))).toBe(true);
    expect(texts.some((t) => /request changes/i.test(t))).toBe(true);
    expect(texts.some((t) => /comment/i.test(t))).toBe(true);
  });

  it("emits onChange when decision changes", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PostPRReviewEditor params={{}} onChange={onChange} />,
    );
    await userEvent.click(screen.getByLabelText(/decision/i));
    await userEvent.click(
      screen.getByRole("option", { name: /request changes/i }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ decision: "request_changes" });
  });

  it("emits onChange when typing in body_from", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <PostPRReviewEditor params={{}} onChange={onChange} />,
    );
    await userEvent.type(screen.getByLabelText(/body from/i), "x");
    expect(onChange).toHaveBeenLastCalledWith({ body_from: "x" });
  });
});
