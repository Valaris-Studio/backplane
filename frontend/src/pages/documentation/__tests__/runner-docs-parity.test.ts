// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Guards the runner onboarding docs against the pre-wizard narrative.
// Ground truth is LaunchRunnerWizard.tsx + the runner.launchWizard i18n keys:
// the wizard (Identity → Roles → Config → Launch) auto-binds the workspace,
// creates/links the team itself, and key loss is recovered via rotate-key +
// re-downloading the bundle — not by deleting and recreating the agent.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const inAppDocPath = join(
  testDir,
  "../sections/getting-started-registering-a-runner.tsx",
);
const runnerReadmePath = join(testDir, "../../../../../runner/README.md");
const repoRoot = join(testDir, "../../../../..");
const section = (file: string) => join(testDir, "../sections", file);

const inAppDoc = readFileSync(inAppDocPath, "utf-8");
const runnerReadme = readFileSync(runnerReadmePath, "utf-8");

// Exact strings from the stale docs as of 2026-08-02. Anchored on dead UI
// field labels and dead-flow sentences so an honest rewrite can still use
// words like "workspace" or "team" without tripping them.
const STALE_IN_APP_PHRASES = [
  "Create Runner dialog",
  "Allowed workspaces",
  "Budget (USD)",
  "<strong>Rate limit.</strong>",
  "Rate limit (req / min)",
  "There is no recovery path for the API key",
  "revoke the dead key and create a new one",
  "scroll to the <em>Team</em> panel",
];

const STALE_README_PHRASES = [
  "`/{workspace-slug}/agents` → **Create Runner**",
  "add the runner to a team on the same page",
  "Fill in `allowed_workspaces` explicitly",
];

// runner.launchWizard.stepIdentity / stepBind / stepConfig / stepLaunch
const WIZARD_STEP_LABELS = ["Identity", "Roles", "Config", "Launch"];

describe("in-app doc: getting-started-registering-a-runner", () => {
  it("reads a non-empty doc source (sanity)", () => {
    expect(inAppDoc.length).toBeGreaterThan(0);
  });

  it.each(STALE_IN_APP_PHRASES)(
    "does not describe the dead create-dialog flow: %j",
    (phrase) => {
      expect(inAppDoc).not.toContain(phrase);
    },
  );

  it("presents the Launch runner wizard, not a create dialog", () => {
    expect(inAppDoc).toMatch(/wizard/i);
  });

  it.each(WIZARD_STEP_LABELS)("names the wizard step %j", (label) => {
    expect(inAppDoc).toMatch(new RegExp(`\\b${label}\\b`));
  });

  it("describes key-loss recovery via rotation, not delete-and-recreate", () => {
    expect(inAppDoc).toMatch(/rotat(e|ing|ion|ed)/i);
  });

  it("mentions re-downloading the config bundle after rotation", () => {
    expect(inAppDoc).toMatch(/re-?download|updated bundle/i);
  });
});

describe("runner/README.md quickstart", () => {
  it("reads a non-empty README (sanity)", () => {
    expect(runnerReadme.length).toBeGreaterThan(0);
  });

  it.each(STALE_README_PHRASES)(
    "does not repeat the pre-wizard onboarding narrative: %j",
    (phrase) => {
      expect(runnerReadme).not.toContain(phrase);
    },
  );
});

// The same pre-wizard narrative survived in doc pages the BP-FE-002 rewrite
// did not cover. Each entry pins the exact stale strings for one file: dead UI
// affordances ("Create Runner" button, the four-field dialog), the retired
// `/{slug}/agents` console URL, and allowed_workspaces-as-a-fix — a remedy that
// is unreachable now that the wizard binds the workspace itself.
const SWEPT_DOCS: { label: string; path: string; stale: string[] }[] = [
  {
    label: "getting-started-your-first-pipeline-run",
    path: section("getting-started-your-first-pipeline-run.tsx"),
    stale: [
      "/agents</code>",
      "Budget: $20.00 / week",
      "Rate limit: 60 rpm",
    ],
  },
  {
    label: "getting-started-troubleshooting-your-first-run",
    path: section("getting-started-troubleshooting-your-first-run.tsx"),
    stale: [
      "/agents/pipeline</code>",
      "/agents</code>",
      "add\n        the current workspace slug to <code>allowed_workspaces</code>",
    ],
  },
  {
    label: "operating-reading-the-runner-overview",
    path: section("operating-reading-the-runner-overview.tsx"),
    stale: ["/agents</code>", "primary button 'Create Runner'"],
  },
  {
    label: "core-concepts-runners",
    path: section("core-concepts-runners.tsx"),
    stale: ["a 'Create Runner' button in the top-right"],
  },
  {
    label: "getting-started-creating-your-first-workspace",
    path: section("getting-started-creating-your-first-workspace.tsx"),
    stale: ["the Create Runner\n        dialog", "/acme-ops/agents"],
  },
  {
    label: "docs/platform-source-of-truth.md",
    path: join(repoRoot, "docs/platform-source-of-truth.md"),
    stale: [
      'Admin clicks "Create Runner"',
      "fills the dialog (name, allowed workspaces, budget, rate limit)",
    ],
  },
];

describe.each(SWEPT_DOCS)("docs-truth sweep: $label", ({ path, stale }) => {
  const source = readFileSync(path, "utf-8");

  it("reads a non-empty source (sanity)", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it.each(stale)("does not present the retired runner flow: %j", (phrase) => {
    expect(source).not.toContain(phrase);
  });
});

// The launch command in the docs locale data must teach the same
// out-of-history form the wizard and runner/README.md hand out. Inline
// `VALARIS_API_KEY=<key>` puts the secret in shell history.
const LOCALE_LAUNCH_COMMANDS = ["en", "es"].map((locale) => ({
  locale,
  path: join(testDir, `../../../i18n/locales/${locale}.json`),
}));

describe.each(LOCALE_LAUNCH_COMMANDS)(
  "docs launch-command copy: $locale.json",
  ({ path }) => {
    const source = readFileSync(path, "utf-8");

    it("does not inline the key into the launch command", () => {
      expect(source).not.toMatch(/VALARIS_API_KEY=<[^>$]/);
    });

    it("teaches the read -s form with the env-var placeholder", () => {
      expect(source).toContain("read -s VALARIS_API_KEY");
      expect(source).toContain("VALARIS_API_KEY=$VALARIS_API_KEY");
    });
  },
);

// `-doctor` is the read-only preflight (agents on PATH, git, forge CLI + auth,
// credentials, backend identity + budget, MCP config, work-dir safety). It
// never spends and exits 1 on failure. Every surface an operator reaches for
// when the runner won't start — or starts and does nothing — must send them
// there FIRST, otherwise they debug blind. runner/README.md already did; these
// are the surfaces that did not.
// `docs/pre-access` is stripped from the public export, so that surface is
// asserted only where it exists; every other surface survives the export.
const DOCTOR_SIGNPOST_SURFACES: {
  label: string;
  path: string;
  privateSurface?: boolean;
}[] = [
  {
    label: "docs/onboarding.md",
    path: join(repoRoot, "docs/onboarding.md"),
  },
  {
    label: "docs/pre-access/setup.md", // export-gated: private doc, asserted only when present
    path: join(repoRoot, "docs/pre-access/setup.md"), // export-gated: private doc, asserted only when present
    privateSurface: true,
  },
  {
    label: "docs/loop-operator-playbook.md",
    path: join(repoRoot, "docs/loop-operator-playbook.md"),
  },
  {
    label: "docs/runner-runtime.md",
    path: join(repoRoot, "docs/runner-runtime.md"),
  },
  {
    label: "getting-started-troubleshooting-your-first-run",
    path: section("getting-started-troubleshooting-your-first-run.tsx"),
  },
];

describe.each(
  DOCTOR_SIGNPOST_SURFACES.filter((s) => !s.privateSurface || existsSync(s.path)),
)("doctor-first troubleshooting signpost: $label", ({ path }) => {
  // Read inside each `it` so a missing surface fails one case, not collection.
  it("points operators at the doctor preflight", () => {
    expect(readFileSync(path, "utf-8")).toMatch(/-doctor\b/);
  });

  it("presents doctor as read-only and non-spending", () => {
    expect(readFileSync(path, "utf-8")).toMatch(
      /read-only|never spends|without spending/i,
    );
  });
});

describe("docs/runner-runtime.md launch modes", () => {
  const source = readFileSync(join(repoRoot, "docs/runner-runtime.md"), "utf-8");

  it("documents the interactive wizard as an entry path, not just -config", () => {
    expect(source).toMatch(/wizard/i);
  });

  it("notes doctor's exit-1-on-failure as CI-gate-shaped", () => {
    expect(source).toMatch(/exits? 1|exit code 1/i);
    expect(source).toMatch(/CI gate|CI-gate/i);
  });
});

// The wizard's Launch step is where a first-time operator is standing when the
// runner fails to come up, so the doctor hint has to live there — and, being
// component copy rather than an English-only docs page, it goes through i18n.
describe.each(["en", "es"])("wizard doctor hint copy: %s.json", (locale) => {
  const catalog = JSON.parse(
    readFileSync(join(testDir, `../../../i18n/locales/${locale}.json`), "utf-8"),
  );

  it("defines the doctor troubleshooting keys", () => {
    expect(catalog.runner.launchWizard.doctorHint).toBeTruthy();
    expect(catalog.runner.launchWizard.doctorLabel).toBeTruthy();
  });

  it("keeps the -doctor flag verbatim in the localized copy", () => {
    expect(catalog.runner.launchWizard.doctorHint).toContain("-doctor");
  });
});
