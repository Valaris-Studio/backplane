#!/usr/bin/env node
// Bundle-isolation gate for editor P1-3 (mermaid).
//
// mermaid is ~150-250 KB gz on first flowchart. It must cost 0 KB to everyone
// who never opens a diagram, which holds only while the import inside
// lib/mermaid-render.ts stays dynamic. Turning it into a static top-level
// import still typechecks, still passes every unit test (the module is mocked
// there) and silently moves the whole library into the entry chunk — this
// script is the only thing that catches that.
//
// Runs AFTER `pnpm build`, never inside `pnpm test`: it reads real build
// output. Usage: pnpm build && pnpm check:mermaid-chunk
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const assetsDir = path.resolve(import.meta.dirname, "..", "dist", "assets");

let assets;
try {
  assets = readdirSync(assetsDir);
} catch {
  console.error(`✗ no build output at ${assetsDir} — run \`pnpm build\` first`);
  process.exit(1);
}

const mermaidChunks = assets.filter((f) => /mermaid.*\.js$/i.test(f));
if (mermaidChunks.length === 0) {
  console.error("✗ no dist/assets/*mermaid*.js chunk — the dynamic import was dropped");
  process.exit(1);
}

// Directive syntax also appears in documentation. The remaining markers are
// Mermaid's diagram registrations, which must remain inside its lazy boundary.
const LIBRARY_MARKERS = ["flowchart-v2", "sequenceDiagram"];

// Lazy route modules can also be named index-*.js. Start from the actual HTML
// entry and inspect imports, rather than guessing entry status from filenames.
const html = readFileSync(path.join(assetsDir, "..", "index.html"), "utf8");
const entryChunks = [...html.matchAll(/<script\b([^>]*)>/gi)].flatMap(([, attributes]) => {
  if (!/\btype\s*=\s*["']module["']/i.test(attributes)) return [];
  const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
  return source ? [path.basename(source)] : [];
});
if (entryChunks.length === 0) {
  console.error("✗ no module entry in dist/index.html");
  process.exit(1);
}

function imports(source, filename) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const dependencies = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.push({ specifier: node.moduleSpecifier.text, dynamic: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      dependencies.push({ specifier: node.arguments[0].text, dynamic: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return dependencies;
}

const leaks = [];
const visited = new Set();
const pending = [...entryChunks];
let dynamicBoundary = false;
while (pending.length > 0) {
  const chunk = pending.pop();
  if (visited.has(chunk)) continue;
  visited.add(chunk);
  const source = readFileSync(path.join(assetsDir, chunk), "utf8");
  const found = LIBRARY_MARKERS.filter((marker) => source.includes(marker));
  if (found.length > 0) leaks.push(`${chunk} contains mermaid library markers: ${found.join(", ")}`);
  for (const { specifier, dynamic } of imports(source, chunk)) {
    if (!specifier.startsWith(".") || !specifier.endsWith(".js")) continue;
    const dependency = path.normalize(path.join(path.dirname(chunk), specifier));
    if (mermaidChunks.includes(dependency)) {
      if (dynamic) dynamicBoundary = true;
      else leaks.push(`${chunk} has an eager Mermaid dependency: ${dependency}`);
      continue;
    }
    // Route/editor chunks may load before any diagram is opened. Follow their
    // dynamic imports too, stopping only at the Mermaid library boundary.
    pending.push(dependency);
  }
}

if (!dynamicBoundary) leaks.push("no reachable dynamic import of a Mermaid chunk");
if (leaks.length > 0) {
  for (const leak of leaks) console.error(`✗ ${leak}`);
  console.error("  mermaid must stay behind the dynamic import in lib/mermaid-render.ts");
  process.exit(1);
}

console.log(`✓ mermaid isolated in ${mermaidChunks.join(", ")}; ${visited.size} application chunks checked`);
