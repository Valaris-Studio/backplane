// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";

// Force the reduced-motion path so gsap doesn't leave elements with opacity:0
// and the copy button stays interactable in jsdom.
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  CodeExample,
  DangerZone,
  FutureState,
  HonestRemark,
  ImportantNote,
  ProTip,
  Screenshot,
  WhatThisIsNot,
} from "../callouts";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Callout variants", () => {
  it.each([
    {
      name: "HonestRemark",
      Component: HonestRemark,
      variant: "honest",
    },
    {
      name: "ImportantNote",
      Component: ImportantNote,
      variant: "important",
    },
    {
      name: "WhatThisIsNot",
      Component: WhatThisIsNot,
      variant: "what-is-not",
    },
    { name: "ProTip", Component: ProTip, variant: "protip" },
    { name: "DangerZone", Component: DangerZone, variant: "danger" },
    { name: "FutureState", Component: FutureState, variant: "future" },
  ])(
    "$name renders title, children, and marks the correct variant",
    ({ Component, variant }) => {
      renderWithProviders(
        <Component title="Heads up">
          <p>Body text for this callout</p>
        </Component>,
      );

      expect(screen.getByText("Heads up")).toBeInTheDocument();
      expect(
        screen.getByText("Body text for this callout"),
      ).toBeInTheDocument();

      const root = screen
        .getByText("Body text for this callout")
        .closest("[data-callout]") as HTMLElement;
      expect(root).not.toBeNull();
      expect(root.getAttribute("data-callout")).toBe(variant);
    },
  );

  it("renders callouts without a title when one is not provided", () => {
    renderWithProviders(
      <ProTip>
        <p>Tip body</p>
      </ProTip>,
    );
    expect(screen.getByText("Tip body")).toBeInTheDocument();
  });
});

describe("CodeExample", () => {
  it("renders language tag, title, and the code body", () => {
    renderWithProviders(
      <CodeExample language="json" title="Sample config">
        {`{ "hello": "world" }`}
      </CodeExample>,
    );

    expect(screen.getByText("Sample config")).toBeInTheDocument();
    expect(screen.getByText("json")).toBeInTheDocument();
    expect(
      screen.getByText(/"hello":/, { selector: "code" }),
    ).toBeInTheDocument();
  });

  it("copies the code string to the clipboard when the copy button is clicked", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // userEvent.setup() installs its own fake clipboard; overwrite after setup.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const snippet = `const x = 1;`;
    renderWithProviders(
      <CodeExample language="ts">{snippet}</CodeExample>,
    );

    await user.click(screen.getByRole("button", { name: /copy code/i }));
    expect(writeText).toHaveBeenCalledWith(snippet);
  });
});

describe("Screenshot", () => {
  it("renders a single-paragraph description when given a string", () => {
    renderWithProviders(
      <Screenshot
        description="A kanban board with three columns."
        alt="Board in light mode"
        caption="The default view."
      />,
    );

    expect(
      screen.getByText("A kanban board with three columns."),
    ).toBeInTheDocument();
    expect(screen.getByText("The default view.")).toBeInTheDocument();

    const figure = screen
      .getByText("The default view.")
      .closest("figure") as HTMLElement;
    expect(figure.getAttribute("data-alt")).toBe("Board in light mode");
  });

  it("renders a bullet list when the description is an array", () => {
    renderWithProviders(
      <Screenshot
        description={["First item", "Second item", "Third item"]}
        alt="Detailed board"
        caption="Caption text"
      />,
    );

    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").map((el) => el.textContent);
    expect(items).toEqual(["First item", "Second item", "Third item"]);
  });

  it("exposes the screenshot tag visibly", () => {
    renderWithProviders(
      <Screenshot
        description="Anything"
        alt="x"
        caption="y"
      />,
    );
    expect(screen.getByText("[SCREENSHOT]")).toBeInTheDocument();
  });
});
