// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import i18n from "@/i18n/config";
import { http, HttpResponse, server } from "@/test/msw-server";
import { LifecycleStepEditor } from "../LifecycleStepEditor";
import type { LifecycleKindName, LifecycleStep } from "../../../api/pipelineConfig";
import type { DraftStep } from "../lifecycleDraft";

// The editor teaches each kind: it fetches GET /api/config/lifecycle-kinds and
// shows the selected kind's distilled knowledge (summary / when-to-use /
// gotcha) so a pipeline can be configured WITH knowledge.

const KNOWN_KINDS: LifecycleKindName[] = ["discover", "claim", "ship"];

function mkStep(name: string, kind: LifecycleKindName): DraftStep {
  return { name, kind, params: {}, _dndId: `lcstep-${name}` } as DraftStep;
}

const DOCS = {
  discover: {
    summary: "Finds the next eligible card for this role and reserves it.",
    when_to_use: "As the first step of a role, to pull work.",
    gotcha: "Params are ignored at runtime.",
  },
  claim: {
    summary: "Takes ownership of the discovered card.",
    when_to_use: "Right after discover, before any real work.",
    gotcha: "pipeline_role is the canonical role key.",
  },
  ship: {
    summary: "Moves the card to its next column and stamps PR metadata.",
    when_to_use: "As the terminal step of an implementer role.",
  },
};

function handlers() {
  return [
    http.get("/api/config/lifecycle-kinds", () =>
      HttpResponse.json({
        kinds: {
          discover: { name: "discover", params_schema: {}, produces_decision: false, terminal: false },
          claim: { name: "claim", params_schema: {}, produces_decision: false, terminal: false },
          ship: { name: "ship", params_schema: {}, produces_decision: false, terminal: true },
        },
        docs: DOCS,
      }),
    ),
  ];
}

function renderEditor(step: DraftStep, onChange = (_: LifecycleStep) => {}) {
  server.use(...handlers());
  return renderWithProviders(
    <LifecycleStepEditor
      step={step}
      peerStepNames={[step.name]}
      knownKinds={KNOWN_KINDS}
      role="implementer"
      workspaceSlug="test-ws"
      onChange={onChange}
      onDelete={() => {}}
    />,
  );
}

describe("LifecycleStepEditor — kind knowledge", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("localizes the selected kind's knowledge by stable kind", async () => {
    await i18n.changeLanguage("pt-BR");
    const summaryKey = "lifecycleKindCatalog.discover.summary";
    const whenToUseKey = "lifecycleKindCatalog.discover.whenToUse";
    const gotchaKey = "lifecycleKindCatalog.discover.gotcha";
    expect(i18n.t(summaryKey)).not.toBe(summaryKey);
    expect(i18n.t(whenToUseKey)).not.toBe(whenToUseKey);
    expect(i18n.t(gotchaKey)).not.toBe(gotchaKey);

    renderEditor(mkStep("discover", "discover"));
    await waitFor(() =>
      expect(
        screen.getByText(i18n.t(summaryKey)),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(i18n.t(whenToUseKey))).toBeInTheDocument();
    expect(screen.getByTestId("kind-doc-gotcha")).toHaveTextContent(
      i18n.t(gotchaKey),
    );
    expect(
      screen.queryByText(DOCS.discover.summary),
    ).not.toBeInTheDocument();
  });

  it("calls out the gotcha when the kind has one", async () => {
    renderEditor(mkStep("claim", "claim"));
    await waitFor(() =>
      expect(screen.getByTestId("kind-doc-gotcha")).toHaveTextContent(
        i18n.t("lifecycleKindCatalog.claim.gotcha"),
      ),
    );
  });

  it("omits the gotcha block for a kind without one", async () => {
    const summaryKey = "lifecycleKindCatalog.ship.summary";
    expect(i18n.t(summaryKey)).not.toBe(summaryKey);
    renderEditor(mkStep("ship", "ship"));
    await waitFor(() =>
      expect(
        screen.getByText(i18n.t(summaryKey)),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("kind-doc-gotcha")).not.toBeInTheDocument();
  });

  it("surfaces the terminal flag in plain language for a terminal kind", async () => {
    renderEditor(mkStep("ship", "ship"));
    await waitFor(() =>
      expect(screen.getByTestId("kind-doc-flags")).toBeInTheDocument(),
    );
    // ship is terminal → the editor tells the operator this step ends the run.
    expect(screen.getByTestId("kind-doc-flags")).toHaveTextContent(/ends the/i);
  });
});
