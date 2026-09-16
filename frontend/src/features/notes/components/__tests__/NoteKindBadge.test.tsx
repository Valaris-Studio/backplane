// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/i18n/config";
import { NoteKindBadge } from "../NoteKindBadge";

describe("NoteKindBadge", () => {
  it("renders nothing for a plain human note", () => {
    const { container } = render(<NoteKindBadge kind="user_note" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("marks agent-authored notes with a Runner badge and a type chip", () => {
    render(<NoteKindBadge kind="plan" />);
    expect(screen.getByText("Runner")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("shows the failure class chip for a non-approving verdict", () => {
    render(<NoteKindBadge kind="review_verdict" failureClass="LOGIC" />);
    expect(screen.getByText("Runner")).toBeInTheDocument();
    expect(screen.getByText("Verdict")).toBeInTheDocument();
    expect(screen.getByText("Logic")).toBeInTheDocument();
  });

  it("ignores an unknown failure class", () => {
    render(<NoteKindBadge kind="review_verdict" failureClass="BOGUS" />);
    expect(screen.queryByText("BOGUS")).not.toBeInTheDocument();
    expect(screen.getByText("Verdict")).toBeInTheDocument();
  });
});
