// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { BADGE_SIZE_SM, BADGE_SIZE_MD } from "@/components/ui/badge";
import en from "@/i18n/locales/en.json";
import { ColumnHeader } from "../ColumnHeader";
import { BoardLoopStatusChip } from "../BoardLoopStatusChip";

// jsdom computes no styles from Tailwind classes, so no test here can read
// back a rendered font size. These assert the exact class the size axis
// manipulates on the exact element, which is the strongest available signal in
// this environment — same limitation and treatment as marquee.test.tsx:23-26.
// The owner-visible pixel result was confirmed by eye.

// The harness resolves i18n for real, so the type badge's accessible name is
// the translated `columns.typeLabel` copy rather than the raw key.
const TYPE_LABEL = en.columns.typeLabel;

function renderHeader() {
  return renderWithProviders(
    <ColumnHeader
      name="To Do"
      columnType="backlog"
      cardCount={0}
      slug="acme"
      onRename={vi.fn()}
      onTypeChange={vi.fn()}
      onDelete={vi.fn()}
      sortMode="position"
      onSortChange={vi.fn()}
    />,
  );
}

describe("ColumnHeader — column-type label sizing", () => {
  it("renders the type badge at the small board-chrome size, not the default", () => {
    renderHeader();
    const typeBadge = screen.getByLabelText(TYPE_LABEL);
    expect(typeBadge.className).toContain(BADGE_SIZE_SM);
    expect(typeBadge.className).not.toContain(BADGE_SIZE_MD);
  });

  // The anti-drift assertion, and the one that encodes the owner's actual ask:
  // both pills must resolve to the SAME exported constant, so they cannot
  // silently diverge again the way two independent literals did.
  it("resolves to the same shared size token as the loop pill", () => {
    renderHeader();
    const typeBadge = screen.getByLabelText(TYPE_LABEL);

    renderWithProviders(
      <BoardLoopStatusChip state="off" status={undefined} onClick={vi.fn()} />,
    );
    const loopChip = screen.getByTestId("loop-status-chip");

    expect(typeBadge.className).toContain(BADGE_SIZE_SM);
    expect(loopChip.className).toContain(BADGE_SIZE_SM);
  });
});
