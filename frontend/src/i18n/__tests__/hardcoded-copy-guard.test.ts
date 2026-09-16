// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  compareCopyDebt,
  extractVisibleCopy,
  formatGuardFailure,
  isGuardedSourcePath,
  runHardcodedCopyGuard,
  validateAllowlist,
  type HardcodedCopyAllowlistEntry,
} from "@/test/hardcoded-copy-guard"

describe("hardcoded product copy guard", () => {
  it("extracts visible JSX, accessibility, configuration, and notification copy", () => {
    const occurrences = extractVisibleCopy(
      "frontend/src/features/example/Example.tsx",
      `
        import { toast } from "sonner"

        const action = { label: "Create project", value: "create_project" }

        export function Example({ ready }: { ready: boolean }) {
          if (ready) toast.success(\`Project __PROJECT_NAME__ created\`)
          toast("Build queued")
          prompt("Project name")
          window.prompt("Project code")
          new Notification("Build finished")

          return (
            <section className="grid gap-4" data-testid="example">
              Welcome back
              <input aria-label="Project name" placeholder={ready ? "Name" : "Loading"} />
              <span>{ready ? "Ready" : "Not ready"}</span>
            </section>
          )
        }
      `.replace("__PROJECT_NAME__", "${projectName}"),
    )

    expect(occurrences.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "object-property", text: "Create project" },
      { kind: "notification", text: "Project ${} created" },
      { kind: "notification", text: "Build queued" },
      { kind: "notification", text: "Project name" },
      { kind: "notification", text: "Project code" },
      { kind: "notification", text: "Build finished" },
      { kind: "jsx-text", text: "Welcome back" },
      { kind: "jsx-attribute", text: "Project name" },
      { kind: "jsx-attribute", text: "Name" },
      { kind: "jsx-attribute", text: "Loading" },
      { kind: "jsx-expression", text: "Ready" },
      { kind: "jsx-expression", text: "Not ready" },
    ])
  })

  it("excludes translation keys and technical syntax that cannot render as product copy", () => {
    const occurrences = extractVisibleCopy(
      "frontend/src/features/example/Example.tsx",
      `
        import { useTranslation } from "react-i18next"

        const route = { path: "/projects/:projectId", value: "active", testId: "project-card" }

        export function Example() {
          const { t } = useTranslation()
          return (
            <>
              <a
                className="text-sm font-medium"
                data-testid="project-link"
                href="/projects"
                id="project-link"
                value="active"
              >
                {t("projects.open")}
              </a>
              <pre>pnpm vitest run</pre>
              <code>{"git status --short"}</code>
              <kbd>Command K</kbd>
              <samp>Build complete</samp>
            </>
          )
        }
      `,
    )

    expect(occurrences).toEqual([])
  })

  it("treats short visible labels as product copy instead of global technical tokens", () => {
    const occurrences = extractVisibleCopy(
      "frontend/src/features/example/ShortLabel.tsx",
      "export function ShortLabel() { return <button>OK</button> }",
    )

    expect(occurrences.map(({ kind, slot, text }) => ({ kind, slot, text }))).toEqual([
      { kind: "jsx-text", slot: "button", text: "OK" },
    ])
  })

  it("detects statically declared copy constants with explicit visible-name suffixes", () => {
    const occurrences = extractVisibleCopy(
      "frontend/src/features/example/NamedCopy.tsx",
      `
        const SAVE_LABEL = "Save changes"
        const DIALOG_TITLE = "Project settings"
        const EMPTY_DESCRIPTION = "No projects yet"
        const ERROR_MESSAGE = "Try again"
        const EMPTY_TEXT = "Nothing here"
        const SAVE_LABEL_KEY = "actions.save"
        const TECHNICAL_TITLE = "projects.settings.title"
        const GENERIC_VALUE = "Generic constants stay outside this guard"
        let MUTABLE_LABEL = "Mutable values are not static copy"

        export function NamedCopy() {
          return (
            <section title={DIALOG_TITLE}>
              <p>{EMPTY_DESCRIPTION}</p>
              <p>{ERROR_MESSAGE}</p>
              <p>{EMPTY_TEXT}</p>
              <button>{SAVE_LABEL}</button>
            </section>
          )
        }
      `,
    )

    expect(occurrences.map(({ kind, slot, text }) => ({ kind, slot, text }))).toEqual([
      { kind: "named-constant", slot: "SAVE_LABEL", text: "Save changes" },
      { kind: "named-constant", slot: "DIALOG_TITLE", text: "Project settings" },
      {
        kind: "named-constant",
        slot: "EMPTY_DESCRIPTION",
        text: "No projects yet",
      },
      { kind: "named-constant", slot: "ERROR_MESSAGE", text: "Try again" },
      { kind: "named-constant", slot: "EMPTY_TEXT", text: "Nothing here" },
    ])
  })

  it("detects approved semantic copy slots in JSX attributes and objects", () => {
    const occurrences = extractVisibleCopy(
      "frontend/src/features/example/SemanticCopy.tsx",
      `
        const presentation = {
          description: "Object description",
          subtitle: "Object subtitle",
          helperText: "Object helper",
          emptyMessage: "Object empty message",
          tooltip: "Object tooltip",
          eyebrow: "Object eyebrow",
          caption: "Object caption",
        }

        export function SemanticCopy() {
          return (
            <Card
              description="Attribute description"
              subtitle="Attribute subtitle"
              helperText="Attribute helper"
              emptyMessage="Attribute empty message"
              tooltip="Attribute tooltip"
              eyebrow="Attribute eyebrow"
              caption="Attribute caption"
              data-description="technical-description"
            />
          )
        }
      `,
    )

    expect(occurrences.map(({ kind, slot, text }) => ({ kind, slot, text }))).toEqual([
      { kind: "object-property", slot: "description", text: "Object description" },
      { kind: "object-property", slot: "subtitle", text: "Object subtitle" },
      { kind: "object-property", slot: "helperText", text: "Object helper" },
      { kind: "object-property", slot: "emptyMessage", text: "Object empty message" },
      { kind: "object-property", slot: "tooltip", text: "Object tooltip" },
      { kind: "object-property", slot: "eyebrow", text: "Object eyebrow" },
      { kind: "object-property", slot: "caption", text: "Object caption" },
      { kind: "jsx-attribute", slot: "description", text: "Attribute description" },
      { kind: "jsx-attribute", slot: "subtitle", text: "Attribute subtitle" },
      { kind: "jsx-attribute", slot: "helperText", text: "Attribute helper" },
      { kind: "jsx-attribute", slot: "emptyMessage", text: "Attribute empty message" },
      { kind: "jsx-attribute", slot: "tooltip", text: "Attribute tooltip" },
      { kind: "jsx-attribute", slot: "eyebrow", text: "Attribute eyebrow" },
      { kind: "jsx-attribute", slot: "caption", text: "Attribute caption" },
    ])
  })

  it("ratchets a line-independent, file-scoped multiset so debt may decrease but not grow", () => {
    const baseOccurrences = [
      ...extractVisibleCopy("frontend/src/a.tsx", "const item = { label: 'Save' }"),
      ...extractVisibleCopy("frontend/src/a.tsx", "const other = { label: 'Save' }"),
    ]
    const movedLinesAndReducedOccurrences = extractVisibleCopy(
      "frontend/src/a.tsx",
      "\n\n\n\n\nconst moved = { label: 'Save' }",
    )

    expect(compareCopyDebt(baseOccurrences, movedLinesAndReducedOccurrences, []).violations).toEqual(
      [],
    )

    const increasedOccurrences = [
      ...movedLinesAndReducedOccurrences,
      ...extractVisibleCopy("frontend/src/a.tsx", "const added = { label: 'Save' }"),
    ]
    const report = compareCopyDebt(baseOccurrences, increasedOccurrences, [])

    expect(report.violations.map(({ file, text }) => ({ file, text }))).toEqual([])
    expect(report.baseCount).toBe(2)
    expect(report.currentCount).toBe(2)

    const grownReport = compareCopyDebt(baseOccurrences, [
      ...increasedOccurrences,
      ...extractVisibleCopy("frontend/src/a.tsx", "const duplicate = { label: 'Save' }"),
    ], [])
    expect(grownReport.violations.map(({ file, text }) => ({ file, text }))).toEqual([
      { file: "frontend/src/a.tsx", text: "Save" },
    ])

    const movedFileReport = compareCopyDebt(
      extractVisibleCopy("frontend/src/a.tsx", "const item = { label: 'Save' }"),
      extractVisibleCopy("frontend/src/b.tsx", "const item = { label: 'Save' }"),
      [],
    )
    expect(movedFileReport.violations.map(({ file, text }) => ({ file, text }))).toEqual([
      { file: "frontend/src/b.tsx", text: "Save" },
    ])
  })

  it("accepts only exact, reasoned, count-limited allowlist entries", () => {
    const newOccurrences = [
      ...extractVisibleCopy(
        "frontend/src/i18n/supported-languages.ts",
        "export const locale = { label: 'PT-BR' }",
      ),
      ...extractVisibleCopy(
        "frontend/src/i18n/supported-languages.ts",
        "export const duplicate = { label: 'PT-BR' }",
      ),
    ]
    const allowedPtBr = {
      file: "frontend/src/i18n/supported-languages.ts",
      kind: "object-property",
      slot: "label",
      text: "PT-BR",
      occurrences: 1,
      reason: "Locale selector label is a language code, not translatable product copy.",
    } satisfies HardcodedCopyAllowlistEntry
    const allowlist: HardcodedCopyAllowlistEntry[] = [allowedPtBr]

    expect(compareCopyDebt([], newOccurrences, allowlist).violations).toHaveLength(1)
    expect(
      compareCopyDebt(newOccurrences.slice(0, 1), newOccurrences, allowlist).violations,
    ).toHaveLength(1)
    expect(() =>
      validateAllowlist([
        {
          ...allowedPtBr,
          file: "frontend/src/**/*.ts",
        },
      ]),
    ).toThrow(/exact file path/i)
    expect(() =>
      validateAllowlist([
        {
          ...allowedPtBr,
          reason: "",
        },
      ]),
    ).toThrow(/reason/i)
  })

  it("guards only production TS and TSX files under frontend/src", () => {
    expect(isGuardedSourcePath("frontend/src/components/Card.tsx")).toBe(true)
    expect(isGuardedSourcePath("frontend/src/lib/labels.ts")).toBe(true)
    expect(isGuardedSourcePath("frontend/src/components/Card.test.tsx")).toBe(false)
    expect(isGuardedSourcePath("frontend/src/components/__tests__/Card.tsx")).toBe(false)
    expect(isGuardedSourcePath("frontend/src/test/setup.ts")).toBe(false)
    expect(isGuardedSourcePath("frontend/src/i18n/locales/en.json")).toBe(false)
    expect(isGuardedSourcePath("backend/app/main.py")).toBe(false)
  })

  it("excludes documentation content sources, not neighboring UI", () => {
    const localizedCatalogPath = "frontend/src/pages/documentation/content/en.ts"
    const canonicalSectionPath =
      "frontend/src/pages/documentation/sections/introduction-quick-tour.tsx"
    const neighboringUiPath = "frontend/src/pages/documentation/DocumentationHero.tsx"

    expect(isGuardedSourcePath(localizedCatalogPath)).toBe(false)
    expect(isGuardedSourcePath(canonicalSectionPath)).toBe(false)
    expect(isGuardedSourcePath(neighboringUiPath)).toBe(true)

    const candidateSources: ReadonlyArray<readonly [string, string]> = [
      [localizedCatalogPath, 'export const hero = { title: "Documentation" }'],
      [canonicalSectionPath, "export const Section = () => <p>Canonical documentation</p>"],
      [neighboringUiPath, "export const Hero = () => <h1>Documentation</h1>"],
    ]
    const currentOccurrences = candidateSources.flatMap(([file, source]) =>
      isGuardedSourcePath(file) ? extractVisibleCopy(file, source) : [],
    )

    expect(
      compareCopyDebt([], currentOccurrences, []).violations.map(({ file, text }) => ({
        file,
        text,
      })),
    ).toEqual([{ file: neighboringUiPath, text: "Documentation" }])
  })

  it("excludes only MCP catalog data while guarding neighboring reference UI", () => {
    const catalogDataPath =
      "frontend/src/pages/documentation/mcp-reference/data/cards-work.ts"
    const neighboringReferencePath =
      "frontend/src/pages/documentation/mcp-reference/roleLabels.ts"
    const neighboringExplorerPath =
      "frontend/src/pages/documentation/mcp-reference/DetailPane.tsx"

    expect(isGuardedSourcePath(catalogDataPath)).toBe(false)
    expect(isGuardedSourcePath(neighboringReferencePath)).toBe(true)
    expect(isGuardedSourcePath(neighboringExplorerPath)).toBe(true)

    const candidateSources: ReadonlyArray<readonly [string, string]> = [
      [catalogDataPath, 'export const tool = { description: "Catalog narrative" }'],
      [
        neighboringReferencePath,
        'export const ROLE_LABEL = "Reference navigation"',
      ],
      [
        neighboringExplorerPath,
        "export const DetailPane = () => <h2>Tool details</h2>",
      ],
    ]
    const currentOccurrences = candidateSources.flatMap(([file, source]) =>
      isGuardedSourcePath(file) ? extractVisibleCopy(file, source) : [],
    )

    expect(
      compareCopyDebt([], currentOccurrences, []).violations.map(({ file, text }) => ({
        file,
        text,
      })),
    ).toEqual([
      { file: neighboringExplorerPath, text: "Tool details" },
      { file: neighboringReferencePath, text: "Reference navigation" },
    ])
  })

  it("introduces no unapproved visible product copy relative to the Git base tree", () => {
    const report = runHardcodedCopyGuard()

    expect(report.violations, formatGuardFailure(report)).toEqual([])
  })

  it("skips with an explicit reason outside a Git checkout", () => {
    const originalCwd = process.cwd()
    const isolatedDirectory = mkdtempSync(path.join(tmpdir(), "i18n-copy-no-git-"))
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    try {
      process.chdir(isolatedDirectory)
      const report = runHardcodedCopyGuard()

      expect(report.skippedReason).toMatch(/git repository/i)
      expect(report.changedFiles).toEqual([])
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/skipping/i))
    } finally {
      process.chdir(originalCwd)
      warning.mockRestore()
      rmSync(isolatedDirectory, { recursive: true, force: true })
    }
  })

  it("skips with an explicit reason when the resolved base is HEAD", () => {
    const originalBaseSha = process.env.I18N_COPY_BASE_SHA
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    process.env.I18N_COPY_BASE_SHA = "HEAD"

    try {
      const report = runHardcodedCopyGuard()

      expect(report.skippedReason).toMatch(/same commit/i)
      expect(report.changedFiles).toEqual([])
      expect(warning).toHaveBeenCalledWith(expect.stringMatching(/skipping/i))
    } finally {
      if (originalBaseSha === undefined) delete process.env.I18N_COPY_BASE_SHA
      else process.env.I18N_COPY_BASE_SHA = originalBaseSha
      warning.mockRestore()
    }
  })
})
