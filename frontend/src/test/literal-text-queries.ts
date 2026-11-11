// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { screen, waitFor } from "@testing-library/react";

type LiteralTextScope = Pick<typeof screen, "queryByRole" | "queryAllByText" | "queryByText">;

export function findLiteralTextLink(name: string, scope: LiteralTextScope = screen) {
  return waitFor(() => {
    if (scope.queryAllByText(name).length === 0) throw new Error(`Waiting for link: ${name}`);
    const link = scope.queryByRole("link", { name });
    if (!link) throw new Error(`Waiting for link: ${name}`);
    return link;
  });
}

export function findLiteralText(text: string, scope: LiteralTextScope = screen) {
  return waitFor(() => {
    const match = scope.queryByText(text);
    if (!match) throw new Error(`Waiting for text: ${text}`);
    return match;
  });
}
