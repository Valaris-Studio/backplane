// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldError } from "../field-error";

describe("FieldError", () => {
  it("renders nothing when no messages are given", () => {
    const { container } = render(<FieldError messages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when messages is undefined", () => {
    const { container } = render(<FieldError />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders each message and exposes role=alert", () => {
    render(<FieldError messages={["Required", "Too long"]} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Required");
    expect(alert).toHaveTextContent("Too long");
  });

  it("accepts a single string message", () => {
    render(<FieldError messages="Boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
  });

  it("uses the destructive text color", () => {
    render(<FieldError messages="Bad" />);
    expect(screen.getByRole("alert")).toHaveClass("text-destructive");
  });
});
