// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { TagInput } from "../TagInput";

function Harness({
  initial = [],
  onChange,
}: {
  initial?: string[];
  onChange?: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <TagInput
      tags={tags}
      placeholder="add tag"
      onChange={(next) => {
        setTags(next);
        onChange?.(next);
      }}
    />
  );
}

describe("TagInput keyboard a11y", () => {
  it("Backspace on empty input removes the last tag", () => {
    const handleChange = vi.fn();
    renderWithProviders(
      <Harness initial={["alpha", "bravo"]} onChange={handleChange} />,
    );
    const input = screen.getByPlaceholderText("add tag") as HTMLInputElement;
    expect(input.value).toBe("");

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(handleChange).toHaveBeenLastCalledWith(["alpha"]);
  });

  it("Backspace with non-empty input does not remove tags", () => {
    const handleChange = vi.fn();
    renderWithProviders(
      <Harness initial={["alpha"]} onChange={handleChange} />,
    );
    const input = screen.getByPlaceholderText("add tag") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "br" } });
    handleChange.mockClear();
    fireEvent.keyDown(input, { key: "Backspace" });
    // Backspace shouldn't fire the chip-remove path while typing.
    expect(handleChange).not.toHaveBeenCalled();
  });

  it("Escape clears the in-progress input without committing it", () => {
    const handleChange = vi.fn();
    renderWithProviders(<Harness onChange={handleChange} />);
    const input = screen.getByPlaceholderText("add tag") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(handleChange).not.toHaveBeenCalled();
  });

  it("renders tags as a list with an accessible remove button per tag", () => {
    renderWithProviders(<Harness initial={["alpha", "bravo"]} />);
    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
    // English locale via test setup, label is templated with the tag value.
    expect(
      screen.getByRole("button", { name: /remove tag alpha/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /remove tag bravo/i }),
    ).toBeInTheDocument();
  });

  it("remove button has a visible focus ring class", () => {
    renderWithProviders(<Harness initial={["alpha"]} />);
    const removeBtn = screen.getByRole("button", { name: /remove tag alpha/i });
    expect(removeBtn.className).toMatch(/focus-visible:ring/);
  });
});
