// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentTile } from "./AgentTile";
import { agentDisplayName, agentMonogram } from "./agent-identity";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Group, Row, RowText, RowValue } from "./Group";
import { AppIcon, Icon, TrayGlyph } from "./Icon";
import { IdleDot, LiveDot } from "./LiveDot";
import { Pill } from "./Pill";
import { SectionHead } from "./SectionHead";
import { Spinner } from "./Spinner";
import { StatePanel } from "./StatePanel";

describe("Banner", () => {
  it("defaults to a warning tone with a title, body and actions", () => {
    render(
      <Banner title="Capture is paused" actions={<Button size="sm">Resume</Button>}>
        Sessions you run now are not recorded.
      </Banner>,
    );
    const banner = screen.getByText("Capture is paused").closest("[data-banner]");
    expect(banner).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("Sessions you run now are not recorded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("takes an info, error or success tone and an alert role when asked", () => {
    render(<Banner tone="error" role="alert" title="The request was declined in Backplane" />);
    const banner = screen.getByRole("alert");
    expect(banner).toHaveAttribute("data-tone", "error");
    expect(banner.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("has no live role by default, so static banners are not re-announced", () => {
    render(<Banner tone="info" title="Heads up" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Pill", () => {
  it("renders its label with the requested tone, neutral by default", () => {
    render(
      <>
        <Pill>Idle</Pill>
        <Pill tone="success">Capturing</Pill>
      </>,
    );
    expect(screen.getByText("Idle")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("Capturing")).toHaveAttribute("data-tone", "success");
  });
});

describe("AgentTile", () => {
  it("shows the agent's monogram in its colour and hides it from assistive tech", () => {
    render(<AgentTile agent="codex_cli" />);
    const tile = screen.getByText("Cx");
    expect(tile).toHaveAttribute("data-agent", "codex_cli");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(tile).toHaveAttribute("data-size", "md");
  });

  it("falls back to a neutral tile and a derived monogram for an unknown agent", () => {
    render(<AgentTile agent="gemini" size="sm" />);
    const tile = screen.getByText("Ge");
    expect(tile).toHaveAttribute("data-agent", "unknown");
    expect(tile).toHaveAttribute("data-size", "sm");
  });

  it("names the known agents the way the mockup does", () => {
    expect(agentDisplayName("claude_code")).toBe("Claude Code");
    expect(agentDisplayName("codex_cli")).toBe("Codex");
    expect(agentDisplayName("pi_cli")).toBe("Pi");
    expect(agentDisplayName("gemini")).toBe("gemini");
    expect(agentMonogram("claude_code")).toBe("CC");
  });
});

describe("Group, Row and SectionHead", () => {
  it("renders a titled list of rows with a title, sub-line and value", () => {
    render(
      <>
        <SectionHead title="Account" aside="3 rows" action={<Button size="sm">Open</Button>} />
        <Group label="Account">
          <Row>
            <RowText title="Server" sub="Where this Mac uploads" />
            <RowValue>backplane.example</RowValue>
          </Row>
        </Group>
      </>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Account" })).toBeInTheDocument();
    expect(screen.getByText("3 rows")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Account" });
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByText("Where this Mac uploads")).toBeInTheDocument();
    expect(screen.getByText("backplane.example")).toBeInTheDocument();
  });
});

describe("Spinner", () => {
  it("is decorative by default", () => {
    const { container } = render(<Spinner />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("announces itself when given a label", () => {
    render(<Spinner label="Checking…" />);
    expect(screen.getByRole("status", { name: "Checking…" })).toBeInTheDocument();
  });
});

describe("Icon set", () => {
  it("renders a decorative svg for a named icon", () => {
    const { container } = render(<Icon name="gear" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("data-icon", "gear");
  });

  it("renders each tray glyph with its own masks, so two glyphs never share ids", () => {
    const { container } = render(
      <>
        <TrayGlyph state="paused" />
        <TrayGlyph state="paused" />
      </>,
    );
    const masks = [...container.querySelectorAll("mask")].map((mask) => mask.id);
    expect(masks).toHaveLength(2);
    expect(new Set(masks).size).toBe(2);
  });

  it("renders the app icon as the generated brand tile, the same artwork as the Dock icon", () => {
    const { container } = render(<AppIcon size={72} />);
    const tile = container.querySelector("img");
    expect(tile).toHaveAttribute("src", expect.stringMatching(/app-tile-256\.png$/));
    expect(tile).toHaveAttribute("srcset", expect.stringMatching(/app-tile-48\.png 48w, .*app-tile-96\.png 96w, .*app-tile-256\.png 256w$/));
    expect(tile).toHaveAttribute("sizes", "72px");
    expect(tile).toHaveAttribute("width", "72");
    expect(tile).toHaveAttribute("height", "72");
  });

  it("keeps the app icon decorative and draws no hand-made plane", () => {
    const { container } = render(<AppIcon size={22} />);
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    expect(container.querySelector("img")).toHaveAttribute("sizes", "22px");
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("never uses inline style attributes (the CSP has style-src 'self')", () => {
    const { container } = render(
      <>
        <Icon name="alert" />
        <TrayGlyph state="attention" />
        <TrayGlyph state="offline" />
        <AppIcon size={22} />
      </>,
    );
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
});

describe("LiveDot and StatePanel", () => {
  it("renders live and idle dots as decoration", () => {
    const { container } = render(
      <>
        <LiveDot />
        <IdleDot />
      </>,
    );
    expect(container.querySelector("[data-live-dot]")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[data-idle-dot]")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a titled state panel with a tone, glyph and actions", () => {
    render(
      <StatePanel tone="error" icon="power" title="This Mac was disconnected" actions={<Button>Connect again</Button>}>
        Its access was removed in Backplane.
      </StatePanel>,
    );
    const heading = screen.getByRole("heading", { level: 3, name: "This Mac was disconnected" });
    expect(heading.closest("[data-panel]")).toHaveAttribute("data-tone", "error");
    expect(screen.getByRole("button", { name: "Connect again" })).toBeInTheDocument();
  });
});
