// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const FRONTEND_ROOT = path.resolve(__dirname, "../../..")

function source(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8")
}

describe("loose Backplane-owned product copy", () => {
  it.each([
    ["src/components/ui/dialog.tsx", 't("common.close")', ">Close<"],
    ["src/components/ui/sheet.tsx", 't("common.close")', ">Close<"],
    [
      "src/features/resources/components/preview/PdfPreview.tsx",
      't("resources.pdfPreview")',
      'title="PDF preview"',
    ],
    [
      "src/features/activity/components/ActivityTimeline.tsx",
      't("activity.viaApiKey"',
      ">via {activity.via_api_key}",
    ],
    [
      "src/features/kanban/components/CardDetailSheet.tsx",
      't("cards.viewAllNotes")',
      'defaultValue: "View all notes"',
    ],
    [
      "src/components/shared/RichTextEditorImpl.tsx",
      't("editor.linkUrlPrompt")',
      'window.prompt("URL"',
    ],
    [
      "src/components/ui/editor-sheet.tsx",
      't("editor.a11yTitle")',
      'a11yTitle ?? "Editor"',
    ],
    ["src/components/layout/Sidebar.tsx", 't("nav.home")', 'slug || "home"'],
    [
      "src/features/agents/components/AgentDetail.tsx",
      't("agents.runnerDescription"',
      "runner`}",
    ],
    [
      "src/features/definitions/components/DefinitionEditor.tsx",
      't("definitions.defaultMilestoneTitle")',
      'title: "Start"',
    ],
  ])("routes %s through its semantic locale key", (file, localeCall, rawCopy) => {
    const contents = source(file)

    expect(contents).toContain(localeCall)
    expect(contents).not.toContain(rawCopy)
  })

  it.each([
    [
      "src/features/resources/components/preview/PdfPreview.tsx",
      't("resources.pdfFallback")',
      't("resources.pdfFallback",',
    ],
    [
      "src/components/ui/rich-tooltip.tsx",
      't("ui.tooltips.clickForDetails")',
      't("ui.tooltips.clickForDetails",',
    ],
    [
      "src/features/agents/components/PromptConfigPage.tsx",
      't("common.create")',
      'defaultValue: "Create"',
    ],
  ])("removes the English fallback from %s", (file, localeCall, englishFallback) => {
    const contents = source(file)

    expect(contents).toContain(localeCall)
    expect(contents).not.toContain(englishFallback)
  })

})
