// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { $, expect } from "@wdio/globals";

describe("Backplane Companion app", () => {
  it("launches and shows the status streamed by the fake daemon", async () => {
    await expect($('[data-testid="status-header"]')).toHaveText(expect.stringContaining("Capturing"), { wait: 30_000 });
    // The fake daemon streams no sessions, so Home is empty; the counts come from its status.
    await expect($('[data-testid="screen-home"] h3')).toHaveText("No sessions yet");
    await expect($('[data-testid="screen-home"] dd')).toHaveText("2");
  });
});
