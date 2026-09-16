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
  ...props
}: {
  initial?: string[];
  onChange?: (tags: string[]) => void;
  id?: string;
  "aria-labelledby"?: string;
  placeholder?: string;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <TagInput
      tags={tags}
      onChange={(next) => {
        setTags(next);
        onChange?.(next);
      }}
      {...props}
    />
  );
}

describe("TagInput", () => {
  it("adds a tag on Enter and removes via the X button", () => {
    const handleChange = vi.fn();
    renderWithProviders(<Harness onChange={handleChange} placeholder="add tag" />);

    const input = screen.getByPlaceholderText("add tag") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(handleChange).toHaveBeenLastCalledWith(["alpha"]);
    expect(screen.getByText("alpha")).toBeInTheDocument();

    const removeButton = screen.getByText("alpha").querySelector("button");
    expect(removeButton).toBeTruthy();
    fireEvent.click(removeButton!);
    expect(handleChange).toHaveBeenLastCalledWith([]);
  });

  it("applies the id prop to the underlying input", () => {
    renderWithProviders(<Harness id="my-tag-input" placeholder="tags" />);
    const input = screen.getByPlaceholderText("tags");
    expect(input).toHaveAttribute("id", "my-tag-input");
  });

  it("applies aria-labelledby to the underlying input", () => {
    renderWithProviders(
      <Harness aria-labelledby="external-label" placeholder="tags" />,
    );
    const input = screen.getByPlaceholderText("tags");
    expect(input).toHaveAttribute("aria-labelledby", "external-label");
  });
});
