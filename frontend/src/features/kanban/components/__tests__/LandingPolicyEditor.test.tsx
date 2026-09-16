// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, waitFor, userEvent } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import i18n from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";

interface Policy {
  version: 1;
  landing_actor: "agent" | "platform" | "human";
  landing_methods: ("merge_queue" | "external")[];
  source_review: "none" | "independent";
  review_role: string | null;
  require_forge_checks: boolean;
  postmerge_validation: {
    role: string;
    checks: { id: string; argv: string[]; timeout_seconds: number }[];
  } | null;
  evidence_only: {
    enabled: boolean;
    approval: "none" | "independent";
    review_role: string | null;
  };
  dependency_release: "done" | "accepted";
  auto_complete: boolean;
}

const POLICY_URL = "/api/workspaces/acme/boards/board-1/completion/policy";
const PREVIEW_URL = `${POLICY_URL}/preview`;

const CUSTOM_POLICY: Policy = {
  version: 1,
  landing_actor: "human",
  landing_methods: ["external"],
  source_review: "independent",
  review_role: "release-auditor",
  require_forge_checks: true,
  postmerge_validation: {
    role: "product-verifier",
    checks: [
      {
        id: "export-install-smoke",
        argv: ["./scripts/qualify", "--profile", "customer package"],
        timeout_seconds: 417,
      },
    ],
  },
  evidence_only: {
    enabled: true,
    approval: "independent",
    review_role: "evidence-auditor",
  },
  dependency_release: "accepted",
  auto_complete: false,
};

function resolution(policy: Policy | null, workspacePolicy: Policy | null = null) {
  return {
    override: policy,
    workspace_policy: workspacePolicy,
    effective_policy: policy ?? workspacePolicy,
    origin: policy ? "board" : workspacePolicy ? "workspace" : "legacy",
    policy_hash: policy || workspacePolicy ? "policy-hash" : null,
    capabilities: {},
    incompatibilities: [],
    changes: [],
  };
}

async function renderEditor(initialValue: Policy | null = CUSTOM_POLICY) {
  // Dynamic import keeps the locale regressions independently runnable while
  // the test-first component contract has no implementation yet.
  const editorModule = "../LandingPolicyEditor";
  const { LandingPolicyEditor } = await import(/* @vite-ignore */ editorModule);
  const onChange = vi.fn();
  const onApply = vi.fn();

  function Harness() {
    const [value, setValue] = useState<Policy | null>(structuredClone(initialValue));
    return (
      <LandingPolicyEditor
        slug="acme"
        boardId="board-1"
        value={value}
        onChange={(next: Policy | null) => {
          onChange(next);
          setValue(next);
        }}
        onApply={onApply}
      />
    );
  }

  return { ...renderWithProviders(<Harness />), onChange, onApply };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  server.use(
    http.get(POLICY_URL, () => HttpResponse.json(resolution(CUSTOM_POLICY))),
    http.post(PREVIEW_URL, async ({ request }) => {
      const { policy } = (await request.json()) as { policy: Policy | null };
      return HttpResponse.json(resolution(policy));
    }),
  );
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("LandingPolicyEditor", () => {
  it("leaves inherited legacy behavior untouched when the editor opens", async () => {
    server.use(http.get(POLICY_URL, () => HttpResponse.json(resolution(null))));
    const { onChange } = await renderEditor(null);

    expect(await screen.findByText(/legacy behavior/i)).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /inherit/i })).toBeVisible();
  });

  it("shows that an inherited workspace policy supplies the effective controls", async () => {
    server.use(
      http.get(POLICY_URL, () =>
        HttpResponse.json(resolution(null, CUSTOM_POLICY)),
      ),
      http.post(PREVIEW_URL, () =>
        HttpResponse.json(resolution(null, CUSTOM_POLICY)),
      ),
    );
    const { onChange } = await renderEditor(null);

    expect(await screen.findByText(/inherited from (the )?workspace/i)).toBeVisible();
    expect(screen.getByText("release-auditor")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    { preset: "Reviewed", actor: "platform", review: "independent" },
    { preset: "Agent-managed", actor: "agent", review: "none" },
    { preset: "Validated", actor: "platform", review: "independent" },
  ])("$preset preserves operator-defined roles and exact check arguments", async ({ preset, actor, review }) => {
    const { onChange } = await renderEditor();
    await userEvent.setup().click(await screen.findByRole("button", { name: preset }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        landing_actor: actor,
        landing_methods: ["merge_queue"],
        source_review: review,
        review_role: "release-auditor",
        postmerge_validation: CUSTOM_POLICY.postmerge_validation,
        evidence_only: CUSTOM_POLICY.evidence_only,
      }),
    );
  });

  it("previews null when the operator explicitly returns to inheritance", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(PREVIEW_URL, async ({ request }) => {
        const body = (await request.json()) as { policy: Policy | null };
        bodies.push(body);
        return HttpResponse.json(resolution(body.policy, CUSTOM_POLICY));
      }),
    );
    const { onChange } = await renderEditor();

    await userEvent.setup().click(await screen.findByRole("button", { name: /inherit/i }));

    expect(onChange).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(bodies).toContainEqual({ policy: null }));
    expect(await screen.findByText(/inherited from (the )?workspace/i)).toBeVisible();
  });

  it("blocks Apply until the server has validated the current proposed policy", async () => {
    const gate = deferred();
    let requests = 0;
    server.use(
      http.post(PREVIEW_URL, async () => {
        requests += 1;
        await gate.promise;
        return HttpResponse.json(resolution(CUSTOM_POLICY));
      }),
    );
    const { onApply } = await renderEditor();

    try {
      await waitFor(() => expect(requests).toBe(1));
      expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
      expect(onApply).not.toHaveBeenCalled();
    } finally {
      gate.release();
    }

    const apply = screen.getByRole("button", { name: /apply/i });
    await waitFor(() => expect(apply).toBeEnabled());
    await userEvent.setup().click(apply);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a previous successful preview after changing a preset", async () => {
    const gate = deferred();
    let requests = 0;
    server.use(
      http.post(PREVIEW_URL, async ({ request }) => {
        const { policy } = (await request.json()) as { policy: Policy };
        requests += 1;
        if (policy.landing_actor === "platform") await gate.promise;
        return HttpResponse.json(resolution(policy));
      }),
    );
    await renderEditor();
    const apply = await screen.findByRole("button", { name: /apply/i });
    await waitFor(() => expect(apply).toBeEnabled());

    try {
      await userEvent.setup().click(screen.getByRole("button", { name: "Reviewed" }));
      expect(apply).toBeDisabled();
      await waitFor(() => expect(requests).toBe(2));
    } finally {
      gate.release();
    }
    await waitFor(() => expect(apply).toBeEnabled());
  });

  it("shows actionable incompatibility and refuses Apply without relaxing the proposal", async () => {
    server.use(
      http.post(PREVIEW_URL, () =>
        HttpResponse.json({
          ...resolution(CUSTOM_POLICY),
          incompatibilities: [{
            code: "unsupported_forge_capability",
            field: "postmerge_validation",
            message: "This repository cannot resolve the exact merged commit. Choose a supported forge connection.",
          }],
        }),
      ),
    );
    const { onChange, onApply } = await renderEditor();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Choose a supported forge connection");
    expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("keeps Apply disabled if the compatibility service is unavailable", async () => {
    server.use(http.post(PREVIEW_URL, () => new HttpResponse(null, { status: 503 })));
    const { onApply } = await renderEditor();

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });
});

const COPY_KEYS = [
  "title", "inherit", "apply", "previewPending", "previewFailed",
  "origin.board", "origin.workspace", "origin.legacy",
  "presets.agentManaged", "presets.reviewed", "presets.validated", "presets.human",
  "landingActor", "landingMethods", "sourceReview", "reviewRole",
  "requireForgeChecks", "postmergeValidation", "evidenceOnly", "dependencyRelease",
] as const;

function lookup(catalog: unknown, key: string): unknown {
  return `completionPolicy.${key}`.split(".").reduce<unknown>(
    (node, part) => node && typeof node === "object"
      ? (node as Record<string, unknown>)[part]
      : undefined,
    catalog,
  );
}

describe("landing policy locales", () => {
  it.each(Object.entries({ en, es, "pt-BR": ptBR }))(
    "%s contains translated policy controls and effective-policy states",
    (locale, catalog) => {
      for (const key of COPY_KEYS) {
        const value = lookup(catalog, key);
        expect(value, `${locale}: completionPolicy.${key}`).toEqual(expect.any(String));
        expect((value as string).trim()).not.toBe("");
        if (locale !== "en") expect(value).not.toBe(lookup(en, key));
      }
    },
  );
});


it("renders structured preview changes from the backend without exposing raw policy JSON", async () => {
  server.use(http.post(PREVIEW_URL, () => HttpResponse.json({ ...resolution(CUSTOM_POLICY), changes: [{ field: "landing_actor", before: "agent", after: "human" }, { field: "source_review", before: "none", after: "independent" }] })));
  await renderEditor();
  expect(await screen.findByText("Who lands work: Agent via platform → Human operator")).toBeVisible();
});

it("explains invalid role/check proposals using server validation findings", async () => {
  server.use(http.post(PREVIEW_URL, () => HttpResponse.json({ detail: [{ loc: ["body", "policy", "postmerge_validation"], msg: "Independent validation requires a configured role" }] }, { status: 422 })));
  await renderEditor();
  expect(await screen.findByRole("alert")).toHaveTextContent("Independent validation requires a configured role");
});

it("shows exact byte usage and identifiable contributors separately from the execution limit", async () => {
  server.use(http.post(PREVIEW_URL, () => HttpResponse.json({ ...resolution(CUSTOM_POLICY), context_size: {
    bytes: 140000, limit_bytes: 131072, within_limit: false,
    contributors: [{ source: "note", id: "note-1", title: "Release methodology", bytes: 139000 }],
  }, incompatibilities: [{ code: "completion_context_too_large", message: "Reduce pinned context" }] })));
  await renderEditor();
  expect(await screen.findByText("Mandatory context: 140000 / 131072 UTF-8 bytes")).toBeVisible();
  expect(screen.getByText("Release methodology: 139000 bytes")).toBeVisible();
  expect(screen.getByText(/separate 256 KiB execution limit/)).toBeVisible();
  expect(screen.getByRole("button", { name: /apply policy/i })).toBeDisabled();
});
