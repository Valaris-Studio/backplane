// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import { RichTooltip } from "../rich-tooltip";

describe("RichTooltip — simple summary", () => {
  it("shows the summary on hover and hides on mouse leave", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Click to learn more">
        <span>trigger</span>
      </RichTooltip>,
    );

    const trigger = screen.getByRole("button", { name: /trigger/i });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(trigger);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Click to learn more");

    await user.unhover(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the summary on focus and hides on blur", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Focus help">
        <span>focus me</span>
      </RichTooltip>,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Focus help");
    await user.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not render panel content when only summary is provided", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Just summary">
        <span>trigger</span>
      </RichTooltip>,
    );

    await user.hover(screen.getByRole("button", { name: /trigger/i }));
    await screen.findByRole("tooltip");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("RichTooltip — panel", () => {
  const panel = {
    examples: ["example A", "example B"],
    links: [
      { label: "Docs", href: "https://example.com/docs" },
      { label: "Guide", href: "/guide" },
    ],
  };

  it("opens a dialog with summary, examples, and links when trigger is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Budget controls" panel={panel}>
        <span>budget trigger</span>
      </RichTooltip>,
    );

    const trigger = screen.getByRole("button", { name: /budget trigger/i });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Budget controls" });
    expect(dialog).toHaveTextContent("Budget controls");
    expect(dialog).toHaveTextContent("example A");
    expect(dialog).toHaveTextContent("example B");

    const docsLink = screen.getByRole("link", { name: "Docs" });
    expect(docsLink).toHaveAttribute("href", "https://example.com/docs");
    expect(docsLink).toHaveAttribute("target", "_blank");
    expect(docsLink).toHaveAttribute("rel", expect.stringContaining("noreferrer"));

    const internalLink = screen.getByRole("link", { name: "Guide" });
    expect(internalLink).toHaveAttribute("href", "/guide");
    // internal links should NOT open in a new tab
    expect(internalLink).not.toHaveAttribute("target", "_blank");
  });

  it("toggles closed when trigger is clicked a second time", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="toggle me" panel={panel}>
        <span>trigger</span>
      </RichTooltip>,
    );

    const trigger = screen.getByRole("button", { name: /trigger/i });
    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on Enter and on Space key", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="kb trigger" panel={panel}>
        <span>kb trigger</span>
      </RichTooltip>,
    );

    const trigger = screen.getByRole("button", { name: /kb trigger/i });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.keyboard(" ");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="escape me" panel={panel}>
        <span>trigger</span>
      </RichTooltip>,
    );

    const trigger = screen.getByRole("button", { name: /trigger/i });
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside the popover", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <div>
        <RichTooltip summary="outside click" panel={panel}>
          <span>trigger</span>
        </RichTooltip>
        <div data-testid="outside">outside region</div>
      </div>,
    );

    await user.click(screen.getByRole("button", { name: /trigger/i }));
    await screen.findByRole("dialog");

    await user.click(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("RichTooltip — ARIA", () => {
  it("sets aria-describedby on the trigger and role=tooltip on the summary popup", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="aria summary">
        <span>aria trigger</span>
      </RichTooltip>,
    );

    const trigger = screen.getByRole("button", { name: /aria trigger/i });
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    await user.hover(trigger);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.id).toBe(describedBy);
  });

  it("expanded popover has role=dialog with aria-label equal to the summary", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="labelled dialog"
        panel={{ examples: ["one"] }}
      >
        <span>trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /trigger/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "labelled dialog");
  });
});

// Isolated i18nKey test — mocks react-i18next for this describe block only.
describe("RichTooltip — i18nKey", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sources summary/examples/links from ui.tooltips.<key> when i18nKey is provided", async () => {
    vi.doMock("react-i18next", () => {
      return {
        useTranslation: () => ({
          t: (key: string, options?: { returnObjects?: boolean }) => {
            const store: Record<string, unknown> = {
              "ui.tooltips.i18nFixture.simple": {
                summary: "From i18n",
                examples: ["i18n ex 1", "i18n ex 2"],
                links: [{ label: "i18n link", href: "https://i18n.example" }],
              },
            };
            if (options?.returnObjects) {
              return store[key] ?? key;
            }
            return key;
          },
          i18n: { language: "en" },
        }),
        Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
      };
    });

    const { RichTooltip: RichTooltipIsolated } = await import("../rich-tooltip");
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltipIsolated i18nKey="i18nFixture.simple">
        <span>i18n trigger</span>
      </RichTooltipIsolated>,
    );

    await user.click(screen.getByRole("button", { name: /i18n trigger/i }));
    const dialog = await screen.findByRole("dialog", { name: "From i18n" });
    expect(dialog).toHaveTextContent("From i18n");
    expect(dialog).toHaveTextContent("i18n ex 1");
    expect(dialog).toHaveTextContent("i18n ex 2");
    expect(screen.getByRole("link", { name: "i18n link" })).toHaveAttribute(
      "href",
      "https://i18n.example",
    );

    vi.doUnmock("react-i18next");
  });
});

describe("RichTooltip — rows", () => {
  it("renders a <table> with label <th> and value <td> for each row", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Rows demo"
        panel={{
          rows: [
            { label: "Trigger", value: "pointer" },
            { label: "Use", value: "reviewer" },
          ],
        }}
      >
        <span>rows trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /rows trigger/i }));
    const table = await screen.findByTestId("rt-rows");
    expect(table.tagName).toBe("TABLE");

    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders.map((el) => el.textContent)).toEqual(["Trigger", "Use"]);

    expect(table).toHaveTextContent("pointer");
    expect(table).toHaveTextContent("reviewer");
  });
});

describe("RichTooltip — callouts", () => {
  it("renders one <li> per callout with matching data-variant", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Callouts demo"
        panel={{
          callouts: [
            { variant: "info", text: "informational" },
            { variant: "warn", text: "be careful" },
            { variant: "success", text: "all good" },
          ],
        }}
      >
        <span>callouts trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /callouts trigger/i }));
    const list = await screen.findByTestId("rt-callouts");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-variant", "info");
    expect(items[0]).toHaveTextContent("informational");
    expect(items[1]).toHaveAttribute("data-variant", "warn");
    expect(items[1]).toHaveTextContent("be careful");
    expect(items[2]).toHaveAttribute("data-variant", "success");
    expect(items[2]).toHaveTextContent("all good");
  });

  it("defaults data-variant to 'note' when variant is omitted", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Default variant"
        panel={{ callouts: [{ text: "unlabeled callout" }] }}
      >
        <span>default callout trigger</span>
      </RichTooltip>,
    );

    await user.click(
      screen.getByRole("button", { name: /default callout trigger/i }),
    );
    const list = await screen.findByTestId("rt-callouts");
    const [item] = within(list).getAllByRole("listitem");
    expect(item).toHaveAttribute("data-variant", "note");
    expect(item).toHaveTextContent("unlabeled callout");
  });
});

describe("RichTooltip — code block", () => {
  it("renders a <pre><code> with the literal code string", async () => {
    const user = userEvent.setup();
    const code = '"strategy": "column_scan"';
    renderWithProviders(
      <RichTooltip summary="Code demo" panel={{ code }}>
        <span>code trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /code trigger/i }));
    const pre = await screen.findByTestId("rt-code");
    expect(pre.tagName).toBe("PRE");
    const codeEl = pre.querySelector("code");
    expect(codeEl).not.toBeNull();
    expect(codeEl!.textContent).toBe(code);
  });
});

describe("RichTooltip — sections", () => {
  it("renders one <section> per entry with title and section-scoped content", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Sections demo"
        panel={{
          sections: [
            { title: "Discovery", examples: ["scan column by type"] },
            { title: "Claim", examples: ["lock a card to role"] },
          ],
        }}
      >
        <span>sections trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /sections trigger/i }));
    const sectionsRoot = await screen.findByTestId("rt-sections");
    const headings = within(sectionsRoot).getAllByRole("heading", { level: 4 });
    expect(headings.map((h) => h.textContent)).toEqual(["Discovery", "Claim"]);
    expect(sectionsRoot).toHaveTextContent("scan column by type");
    expect(sectionsRoot).toHaveTextContent("lock a card to role");
  });
});

describe("RichTooltip — links", () => {
  it("external URLs open in a new tab with rel=noreferrer", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Links demo"
        panel={{ links: [{ label: "Docs", href: "https://example.com" }] }}
      >
        <span>ext trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /ext trigger/i }));
    await screen.findByTestId("rt-links");
    const link = screen.getByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("workspace-relative hrefs (no leading slash) are prefixed with /:slug/", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/something"
          element={
            <RichTooltip
              summary="Internal link"
              panel={{ links: [{ label: "Roles", href: "agents/roles" }] }}
            >
              <span>ws trigger</span>
            </RichTooltip>
          }
        />
      </Routes>,
      { routerProps: { initialEntries: ["/acme/something"] } },
    );

    await user.click(screen.getByRole("button", { name: /ws trigger/i }));
    await screen.findByTestId("rt-links");
    const link = screen.getByRole("link", { name: "Roles" });
    expect(link).toHaveAttribute("href", "/acme/agents/roles");
    expect(link).not.toHaveAttribute("target", "_blank");
  });

  it("absolute hrefs pass through unchanged", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/something"
          element={
            <RichTooltip
              summary="Absolute link"
              panel={{ links: [{ label: "Foo", href: "/foo" }] }}
            >
              <span>abs trigger</span>
            </RichTooltip>
          }
        />
      </Routes>,
      { routerProps: { initialEntries: ["/acme/something"] } },
    );

    await user.click(screen.getByRole("button", { name: /abs trigger/i }));
    await screen.findByTestId("rt-links");
    const link = screen.getByRole("link", { name: "Foo" });
    expect(link).toHaveAttribute("href", "/foo");
  });
});

describe("RichTooltip — examples block", () => {
  it("renders <ul data-testid='rt-examples'> with one <li> per example", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Examples demo"
        panel={{ examples: ["first bullet", "second bullet"] }}
      >
        <span>examples trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /examples trigger/i }));
    const list = await screen.findByTestId("rt-examples");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("first bullet");
    expect(items[1]).toHaveTextContent("second bullet");
  });
});

describe("RichTooltip — customPanel escape hatch", () => {
  it("renders customPanel JSX in place of declarative blocks, keeping summary heading", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Custom panel heading"
        customPanel={<div data-testid="my-custom">hello custom</div>}
        // Declarative panel is ignored when customPanel is provided.
        panel={{
          rows: [{ label: "ignored", value: "ignored" }],
          callouts: [{ text: "ignored" }],
          code: "ignored-code",
          examples: ["ignored"],
          links: [{ label: "ignored", href: "/x" }],
          sections: [{ title: "ignored" }],
        }}
      >
        <span>custom trigger</span>
      </RichTooltip>,
    );

    await user.click(screen.getByRole("button", { name: /custom trigger/i }));
    const dialog = await screen.findByRole("dialog", {
      name: "Custom panel heading",
    });
    expect(dialog).toHaveTextContent("Custom panel heading");
    expect(within(dialog).getByTestId("my-custom")).toHaveTextContent(
      "hello custom",
    );
    expect(screen.queryByTestId("rt-rows")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rt-callouts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rt-code")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rt-sections")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rt-examples")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rt-links")).not.toBeInTheDocument();
  });
});

describe("RichTooltip — hover hint visibility", () => {
  it("shows 'Click for details' in the hover tooltip when panel has content", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip
        summary="Hoverable with panel"
        panel={{ examples: ["ex"] }}
      >
        <span>hover-with-panel</span>
      </RichTooltip>,
    );

    await user.hover(screen.getByRole("button", { name: /hover-with-panel/i }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Click for details");
  });

  it("does not show 'Click for details' when only a summary is provided", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Just a summary">
        <span>hover-plain</span>
      </RichTooltip>,
    );

    await user.hover(screen.getByRole("button", { name: /hover-plain/i }));
    const tip = await screen.findByRole("tooltip");
    expect(tip).not.toHaveTextContent("Click for details");
  });
});

// When the trigger wraps a real interactive element (e.g. a live <button>),
// activation belongs to the child: the bubbled click must not toggle the
// expanded panel, and the bubbled (click-driven) focus must not pop the hover
// tooltip over whatever the child just opened.
describe("RichTooltip — interactive child trigger", () => {
  const panel = { examples: ["panel example"] };

  // Both the trigger span (role=button) and the wrapped element match the
  // accessible name; pick the real <button>.
  function getInnerButton() {
    const button = screen
      .getAllByRole("button", { name: "do the thing" })
      .find((el) => el.tagName === "BUTTON");
    expect(button).toBeDefined();
    return button!;
  }

  it("clicking a wrapped <button> fires its onClick without opening the panel or leaving a tooltip", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <RichTooltip summary="Wrapped button help" panel={panel}>
        <button type="button" onClick={onClick}>do the thing</button>
      </RichTooltip>,
    );

    await user.click(getInnerButton());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("pressing Enter on a focused wrapped <button> activates it, not the panel", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <RichTooltip summary="Wrapped button help" panel={panel}>
        <button type="button" onClick={onClick}>do the thing</button>
      </RichTooltip>,
    );

    getInnerButton().focus();
    await user.keyboard("{Enter}");

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keyboard (non-pointer) focus on a wrapped <button> still shows the tooltip (WCAG 1.4.13 parity with hover)", () => {
    renderWithProviders(
      <RichTooltip summary="Wrapped button help" panel={panel}>
        <button type="button">do the thing</button>
      </RichTooltip>,
    );

    // Programmatic focus = no preceding pointerdown = keyboard modality. A Tab
    // user must get the same help a mouse user gets on hover.
    fireEvent.focus(getInnerButton());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Wrapped button help");
  });

  it("click-driven focus on a wrapped <button> does NOT show the tooltip", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Wrapped button help" panel={panel}>
        <button type="button">do the thing</button>
      </RichTooltip>,
    );

    await user.click(getInnerButton());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("still shows the hover tooltip over a wrapped <button> on deliberate hover", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltip summary="Wrapped button help" panel={panel}>
        <button type="button">do the thing</button>
      </RichTooltip>,
    );

    await user.hover(getInnerButton());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Wrapped button help");
  });
});

describe("RichTooltip — legacy shape backwards compat via i18n", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads summary + examples + links from a legacy {summary, examples, links} i18n entry", async () => {
    vi.doMock("react-i18next", () => {
      return {
        useTranslation: () => ({
          t: (key: string, options?: { returnObjects?: boolean }) => {
            const store: Record<string, unknown> = {
              "ui.tooltips.legacyFixture.withExamples": {
                summary: "Short summary that leads, followed by concrete examples.",
                examples: [
                  "Example one: a typical use case.",
                  "Example two: an edge case worth calling out.",
                ],
                links: [],
              },
            };
            if (options?.returnObjects) {
              return store[key] ?? key;
            }
            return key;
          },
          i18n: { language: "en" },
        }),
        Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
      };
    });

    const { RichTooltip: RichTooltipIsolated } = await import("../rich-tooltip");
    const user = userEvent.setup();
    renderWithProviders(
      <RichTooltipIsolated i18nKey="legacyFixture.withExamples">
        <span>legacy trigger</span>
      </RichTooltipIsolated>,
    );

    await user.click(screen.getByRole("button", { name: /legacy trigger/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Short summary that leads, followed by concrete examples.",
    );
    expect(dialog).toHaveTextContent("Example one: a typical use case.");
    expect(dialog).toHaveTextContent("Example two: an edge case worth calling out.");
    expect(screen.getByTestId("rt-examples")).toBeInTheDocument();

    vi.doUnmock("react-i18next");
  });
});
