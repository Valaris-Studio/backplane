// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, configure, getConfig, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { findLiteralText, findLiteralTextLink } from "../literal-text-queries";

const originalElementError = getConfig().getElementError;

afterEach(() => {
  cleanup();
  configure({ getElementError: originalElementError });
  vi.restoreAllMocks();
});

it("waits for literal text before scanning global accessible links, then resolves the real rendered link", async () => {
  const view = render(<p>Loading sessions</p>);
  const roleQuery = vi.spyOn(screen, "queryByRole");
  const pending = findLiteralTextLink("Selected session");
  const queriesBeforeText = roleQuery.mock.calls.length;

  view.rerender(<a href="/acme/sessions/selected"><span>Selected session</span></a>);
  const link = await pending;

  expect(link).toBe(screen.getByRole("link", { name: "Selected session" }));
  expect(link).toHaveAttribute("href", "/acme/sessions/selected");
  expect(link).toBeVisible();
  expect(queriesBeforeText).toBe(0);
  expect(roleQuery).toHaveBeenCalledWith("link", { name: "Selected session" });
});

it.for([
  { reason: "non-link text", content: <span>Selected session</span> },
  { reason: "a different accessible name", content: <a href="/selected" aria-label="Different session">Selected session</a> },
  { reason: "a hidden link", content: <a href="/selected" hidden>Selected session</a> },
])("does not accept $reason as the required visible accessible link", async ({ content }) => {
  render(content);
  await expect(findLiteralTextLink("Selected session")).rejects.toThrow("Selected session");
});

it("keeps global accessible-name uniqueness when only one duplicate has the literal text", async () => {
  render(<>
    <a href="/first">Selected session</a>
    <a href="/second" aria-label="Selected session">Another visible title</a>
  </>);

  await expect(findLiteralTextLink("Selected session")).rejects.toThrow(/multiple elements.*role "link"/i);
});

it("preserves an explicitly supplied query container", async () => {
  const view = render(<>
    <section aria-label="Discovery"><a href="/inside">Selected session</a></section>
    <a href="/outside">Selected session</a>
  </>);
  const scope = within(view.getByRole("region", { name: "Discovery" }));

  expect(await findLiteralTextLink("Selected session", scope)).toHaveAttribute("href", "/inside");
});

it("waits for delayed exact text without constructing missing-element DOM errors on the readiness path", async () => {
  const view = render(<p>Loading preview</p>);
  const elementError = vi.fn(originalElementError);
  configure({ getElementError: elementError });
  const pending = findLiteralText("Authorized preview bytes");
  const errorsBeforeText = elementError.mock.calls.length;

  view.rerender(<p>Authorized preview bytes</p>);
  const text = await pending;

  expect(text).toBe(screen.getByText("Authorized preview bytes"));
  expect(text).toBeVisible();
  expect(errorsBeforeText).toBe(0);
});

it("keeps exact text matching instead of accepting a substring", async () => {
  render(<p>Older Authorized preview bytes are absent</p>);
  await expect(findLiteralText("Authorized preview bytes")).rejects.toThrow("Authorized preview bytes");
});

it("keeps duplicate exact-text failures", async () => {
  render(<><p>Authorized preview bytes</p><p>Authorized preview bytes</p></>);
  await expect(findLiteralText("Authorized preview bytes")).rejects.toThrow(/multiple elements.*text/i);
});
