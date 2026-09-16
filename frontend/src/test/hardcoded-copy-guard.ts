// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import ts from "typescript"

export type VisibleCopyKind =
  | "jsx-text"
  | "jsx-expression"
  | "jsx-attribute"
  | "object-property"
  | "named-constant"
  | "notification"

export interface CopyOccurrence {
  file: string
  kind: VisibleCopyKind
  slot: string
  text: string
  fingerprint: string
  line: number
}

export interface HardcodedCopyAllowlistEntry {
  file: string
  kind: VisibleCopyKind
  slot: string
  text: string
  occurrences: number
  reason: string
}

export interface HardcodedCopyGuardReport {
  baseSha: string | null
  changedFiles: string[]
  skippedReason: string | null
  baseCount: number
  currentCount: number
  allowedCount: number
  violations: CopyOccurrence[]
}

const VISIBLE_ATTRIBUTE_NAMES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "caption",
  "description",
  "emptyMessage",
  "eyebrow",
  "helperText",
  "label",
  "placeholder",
  "subtitle",
  "title",
  "tooltip",
])

const VISIBLE_PROPERTY_NAMES = new Set([
  "actionLabel",
  "buttonText",
  "cancelLabel",
  "caption",
  "confirmLabel",
  "description",
  "emptyMessage",
  "emptyText",
  "eyebrow",
  "heading",
  "helperText",
  "label",
  "message",
  "placeholder",
  "subheading",
  "subtitle",
  "title",
  "tooltip",
])

const VISIBLE_COPY_KINDS = new Set<VisibleCopyKind>([
  "jsx-text",
  "jsx-expression",
  "jsx-attribute",
  "object-property",
  "named-constant",
  "notification",
])

const TECHNICAL_CONTAINER_NAMES = new Set(["code", "kbd", "pre", "samp"])
const DOCUMENTATION_CONTENT_ROOTS = [
  "frontend/src/pages/documentation/content/",
  "frontend/src/pages/documentation/mcp-reference/data/",
  "frontend/src/pages/documentation/sections/",
] as const
const GLOB_META_CHARACTERS = "*?[]{}"
// Matches static copy identifiers with one of the explicitly approved visible slots.
const VISIBLE_COPY_CONSTANT_NAME = /_(?:DESCRIPTION|LABEL|MESSAGE|TEXT|TITLE)$/u
// Matches dot-separated technical keys such as projects.settings.title.
const TECHNICAL_KEY_NAME = /^[a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/u
const LOGICAL_OPERATOR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
])

function normalizeRepositoryPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "")
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/gu, " ").trim()
}

function isProductCopyCandidate(text: string): boolean {
  if (!/\p{L}/u.test(text)) return false
  return !TECHNICAL_KEY_NAME.test(text)
}

function copyFingerprint(
  file: string,
  kind: VisibleCopyKind,
  slot: string,
  text: string,
): string {
  return JSON.stringify([file, kind, slot, text])
}

function jsxTagName(node: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.getText()
  return node.getText()
}

function containingJsxSlot(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent

  while (current) {
    if (ts.isJsxElement(current)) return jsxTagName(current.openingElement.tagName)
    if (ts.isJsxSelfClosingElement(current)) return jsxTagName(current.tagName)
    if (ts.isJsxFragment(current)) return "fragment"
    current = current.parent
  }

  return "jsx"
}

function isInsideTechnicalContainer(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent

  while (current) {
    if (
      ts.isJsxElement(current) &&
      TECHNICAL_CONTAINER_NAMES.has(jsxTagName(current.openingElement.tagName))
    ) {
      return true
    }
    if (
      ts.isJsxSelfClosingElement(current) &&
      TECHNICAL_CONTAINER_NAMES.has(jsxTagName(current.tagName))
    ) {
      return true
    }
    current = current.parent
  }

  return false
}

function expressionDisplayTexts(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text]

  if (ts.isTemplateExpression(expression)) {
    const renderedPattern = expression.templateSpans.reduce(
      (text, span) => `${text}\${}${span.literal.text}`,
      expression.head.text,
    )
    return [renderedPattern]
  }

  if (ts.isConditionalExpression(expression)) {
    return [
      ...expressionDisplayTexts(expression.whenTrue),
      ...expressionDisplayTexts(expression.whenFalse),
    ]
  }

  if (
    ts.isBinaryExpression(expression) &&
    LOGICAL_OPERATOR_KINDS.has(expression.operatorToken.kind)
  ) {
    return [
      ...expressionDisplayTexts(expression.left),
      ...expressionDisplayTexts(expression.right),
    ]
  }

  if (ts.isParenthesizedExpression(expression)) {
    return expressionDisplayTexts(expression.expression)
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return expressionDisplayTexts(expression.expression)
  }
  if (ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
    return expressionDisplayTexts(expression.expression)
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) =>
      ts.isExpression(element) ? expressionDisplayTexts(element) : [],
    )
  }

  return []
}

function staticPropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function notificationSlot(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text === "alert" ||
      expression.text === "confirm" ||
      expression.text === "prompt" ||
      expression.text === "toast"
      ? expression.text
      : null
  }

  if (!ts.isPropertyAccessExpression(expression)) return null

  if (ts.isIdentifier(expression.expression) && expression.expression.text === "toast") {
    return `toast.${expression.name.text}`
  }
  if (
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "window" &&
    (expression.name.text === "alert" ||
      expression.name.text === "confirm" ||
      expression.name.text === "prompt")
  ) {
    return `window.${expression.name.text}`
  }

  return null
}

export function extractVisibleCopy(filePath: string, sourceText: string): CopyOccurrence[] {
  const file = normalizeRepositoryPath(filePath)
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const occurrences: CopyOccurrence[] = []

  function addOccurrence(
    node: ts.Node,
    kind: VisibleCopyKind,
    slot: string,
    rawText: string,
  ): void {
    const text = normalizeVisibleText(rawText)
    if (!isProductCopyCandidate(text)) return

    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    occurrences.push({
      file,
      kind,
      slot,
      text,
      fingerprint: copyFingerprint(file, kind, slot, text),
      line,
    })
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node) && !isInsideTechnicalContainer(node)) {
      addOccurrence(node, "jsx-text", containingJsxSlot(node), node.text)
    }

    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      !isInsideTechnicalContainer(node)
    ) {
      for (const text of expressionDisplayTexts(node.expression)) {
        addOccurrence(node, "jsx-expression", containingJsxSlot(node), text)
      }
    }

    if (ts.isJsxAttribute(node) && !isInsideTechnicalContainer(node)) {
      const attributeName = node.name.getText(sourceFile)
      if (VISIBLE_ATTRIBUTE_NAMES.has(attributeName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          addOccurrence(node, "jsx-attribute", attributeName, node.initializer.text)
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          for (const text of expressionDisplayTexts(node.initializer.expression)) {
            addOccurrence(node, "jsx-attribute", attributeName, text)
          }
        }
      }
    }

    if (ts.isPropertyAssignment(node) && !isInsideTechnicalContainer(node)) {
      const propertyName = staticPropertyName(node.name)
      if (propertyName && VISIBLE_PROPERTY_NAMES.has(propertyName)) {
        for (const text of expressionDisplayTexts(node.initializer)) {
          addOccurrence(node, "object-property", propertyName, text)
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isIdentifier(node.name) &&
      VISIBLE_COPY_CONSTANT_NAME.test(node.name.text) &&
      node.initializer
    ) {
      for (const text of expressionDisplayTexts(node.initializer)) {
        addOccurrence(node, "named-constant", node.name.text, text)
      }
    }

    if (ts.isCallExpression(node) && !isInsideTechnicalContainer(node)) {
      const slot = notificationSlot(node.expression)
      const firstArgument = node.arguments[0]
      if (slot && firstArgument) {
        for (const text of expressionDisplayTexts(firstArgument)) {
          addOccurrence(node, "notification", slot, text)
        }
      }
    }

    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Notification" &&
      !isInsideTechnicalContainer(node)
    ) {
      const firstArgument = node.arguments?.[0]
      if (firstArgument) {
        for (const text of expressionDisplayTexts(firstArgument)) {
          addOccurrence(node, "notification", "Notification", text)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return occurrences
}

export function isGuardedSourcePath(filePath: string): boolean {
  const file = normalizeRepositoryPath(filePath)

  if (!file.startsWith("frontend/src/")) return false
  if (!/\.tsx?$/u.test(file) || /\.d\.ts$/u.test(file)) return false
  if (file.split("/").includes("..")) return false
  if (DOCUMENTATION_CONTENT_ROOTS.some((root) => file.startsWith(root))) {
    return false
  }

  return !(
    file.includes("/__tests__/") ||
    file.includes("/test/") ||
    /\.(?:spec|test|stories)\.tsx?$/u.test(file)
  )
}

export function validateAllowlist(
  entries: readonly HardcodedCopyAllowlistEntry[],
): void {
  const seenEntries = new Set<string>()

  for (const [index, entry] of entries.entries()) {
    const prefix = `Allowlist entry ${index + 1}`
    const file = normalizeRepositoryPath(entry.file)

    if (
      file !== entry.file ||
      !isGuardedSourcePath(file) ||
      [...GLOB_META_CHARACTERS].some((character) => file.includes(character))
    ) {
      throw new Error(`${prefix} must use one exact file path under frontend/src`)
    }
    if (!VISIBLE_COPY_KINDS.has(entry.kind)) {
      throw new Error(`${prefix} has an unsupported copy kind`)
    }
    if (!entry.slot.trim()) throw new Error(`${prefix} must name an exact slot`)
    if (entry.text !== normalizeVisibleText(entry.text) || !entry.text) {
      throw new Error(`${prefix} must use exact normalized text`)
    }
    if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1) {
      throw new Error(`${prefix} must allow a positive integer number of occurrences`)
    }
    if (!entry.reason.trim()) throw new Error(`${prefix} must include a reason`)

    const identity = copyFingerprint(file, entry.kind, entry.slot, entry.text)
    if (seenEntries.has(identity)) {
      throw new Error(`${prefix} duplicates an existing exact allowlist entry`)
    }
    seenEntries.add(identity)
  }
}

export function compareCopyDebt(
  baseOccurrences: readonly CopyOccurrence[],
  currentOccurrences: readonly CopyOccurrence[],
  allowlist: readonly HardcodedCopyAllowlistEntry[],
): HardcodedCopyGuardReport {
  validateAllowlist(allowlist)

  const baseCounts = new Map<string, number>()
  for (const occurrence of baseOccurrences) {
    baseCounts.set(occurrence.fingerprint, (baseCounts.get(occurrence.fingerprint) ?? 0) + 1)
  }

  const currentByFingerprint = new Map<string, CopyOccurrence[]>()
  for (const occurrence of currentOccurrences) {
    const matches = currentByFingerprint.get(occurrence.fingerprint) ?? []
    matches.push(occurrence)
    currentByFingerprint.set(occurrence.fingerprint, matches)
  }

  const allowanceByFingerprint = new Map<string, number>()
  for (const entry of allowlist) {
    allowanceByFingerprint.set(
      copyFingerprint(entry.file, entry.kind, entry.slot, entry.text),
      entry.occurrences,
    )
  }

  const violations: CopyOccurrence[] = []
  let allowedCount = 0

  for (const [fingerprint, currentMatches] of currentByFingerprint) {
    const baseCount = baseCounts.get(fingerprint) ?? 0
    const newCount = Math.max(0, currentMatches.length - baseCount)
    const remainingExactAllowance = Math.max(
      0,
      (allowanceByFingerprint.get(fingerprint) ?? 0) - baseCount,
    )
    const allowedForFingerprint = Math.min(
      newCount,
      remainingExactAllowance,
    )
    allowedCount += allowedForFingerprint

    const violationCount = newCount - allowedForFingerprint
    if (violationCount > 0) violations.push(...currentMatches.slice(-violationCount))
  }

  violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind) ||
      left.slot.localeCompare(right.slot) ||
      left.text.localeCompare(right.text),
  )

  return {
    baseSha: null,
    changedFiles: [],
    skippedReason: null,
    baseCount: baseOccurrences.length,
    currentCount: currentOccurrences.length,
    allowedCount,
    violations,
  }
}

function runGit(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function resolveRepositoryRoot(): string {
  return runGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim()
}

function verifyCommit(repositoryRoot: string, revision: string): string {
  return runGit(repositoryRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).trim()
}

function resolveBaseSha(repositoryRoot: string): string {
  const explicitBaseSha = process.env.I18N_COPY_BASE_SHA?.trim()
  if (explicitBaseSha) return verifyCommit(repositoryRoot, explicitBaseSha)

  for (const candidate of ["origin/main", "main"]) {
    try {
      verifyCommit(repositoryRoot, candidate)
      return runGit(repositoryRoot, ["merge-base", "HEAD", candidate]).trim()
    } catch {
      // Try the next local mainline reference.
    }
  }

  return verifyCommit(repositoryRoot, "HEAD^")
}

function nulSeparatedPaths(output: string): string[] {
  return output
    .split("\0")
    .map(normalizeRepositoryPath)
    .filter(Boolean)
}

function changedSourcePaths(repositoryRoot: string, baseSha: string): string[] {
  const changedPaths = nulSeparatedPaths(
    runGit(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMRD",
      "-z",
      baseSha,
      "--",
      "frontend/src",
    ]),
  )
  const untrackedPaths = nulSeparatedPaths(
    runGit(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "frontend/src",
    ]),
  )

  return [...new Set([...changedPaths, ...untrackedPaths])]
    .filter(isGuardedSourcePath)
    .sort()
}

function sourceFromBase(
  repositoryRoot: string,
  baseSha: string,
  file: string,
): string | null {
  try {
    return runGit(repositoryRoot, ["show", `${baseSha}:${file}`])
  } catch {
    return null
  }
}

function sourceFromWorktree(repositoryRoot: string, file: string): string | null {
  const absolutePath = path.resolve(repositoryRoot, file)
  const sourceRoot = path.resolve(repositoryRoot, "frontend/src")
  if (!absolutePath.startsWith(`${sourceRoot}${path.sep}`) || !existsSync(absolutePath)) {
    return null
  }
  return readFileSync(absolutePath, "utf8")
}

function loadAllowlist(repositoryRoot: string): HardcodedCopyAllowlistEntry[] {
  const allowlistPath = path.join(
    repositoryRoot,
    "frontend/src/test/hardcoded-copy-allowlist.json",
  )
  const parsed: unknown = JSON.parse(readFileSync(allowlistPath, "utf8"))
  if (!Array.isArray(parsed)) throw new Error("Hardcoded copy allowlist must be a JSON array")

  const entries = parsed as HardcodedCopyAllowlistEntry[]
  validateAllowlist(entries)
  return entries
}

export function runHardcodedCopyGuard(): HardcodedCopyGuardReport {
  let repositoryRoot: string
  try {
    repositoryRoot = resolveRepositoryRoot()
  } catch {
    return skippedGuardReport("Git repository metadata is unavailable")
  }
  const baseSha = resolveBaseSha(repositoryRoot)
  const headSha = verifyCommit(repositoryRoot, "HEAD")
  if (baseSha === headSha) {
    return skippedGuardReport("Resolved base and HEAD are the same commit", baseSha)
  }
  const changedFiles = changedSourcePaths(repositoryRoot, baseSha)
  const baseOccurrences: CopyOccurrence[] = []
  const currentOccurrences: CopyOccurrence[] = []

  for (const file of changedFiles) {
    const baseSource = sourceFromBase(repositoryRoot, baseSha, file)
    if (baseSource !== null) baseOccurrences.push(...extractVisibleCopy(file, baseSource))

    const currentSource = sourceFromWorktree(repositoryRoot, file)
    if (currentSource !== null) currentOccurrences.push(...extractVisibleCopy(file, currentSource))
  }

  return {
    ...compareCopyDebt(baseOccurrences, currentOccurrences, loadAllowlist(repositoryRoot)),
    baseSha,
    changedFiles,
    skippedReason: null,
  }
}

function skippedGuardReport(
  reason: string,
  baseSha: string | null = null,
): HardcodedCopyGuardReport {
  console.warn(`[i18n-copy] Skipping hardcoded copy guard: ${reason}`)
  return {
    baseSha,
    changedFiles: [],
    skippedReason: reason,
    baseCount: 0,
    currentCount: 0,
    allowedCount: 0,
    violations: [],
  }
}

export function formatGuardFailure(report: HardcodedCopyGuardReport): string {
  if (report.skippedReason) {
    return `Hardcoded product copy guard skipped: ${report.skippedReason}.`
  }
  if (report.violations.length === 0) {
    return `No unapproved hardcoded product copy found across ${report.changedFiles.length} changed source files.`
  }

  const findings = report.violations.map(
    ({ file, kind, slot, text, line }) =>
      `  - ${file}:${line} [${kind}:${slot}] ${JSON.stringify(text)}`,
  )

  return [
    `Found ${report.violations.length} new hardcoded product-copy occurrence(s) relative to ${report.baseSha ?? "the supplied baseline"}:`,
    ...findings,
    "Move product-owned copy into the locale catalogs. Add an exact allowlist entry only for a technical literal that must remain in source.",
  ].join("\n")
}
