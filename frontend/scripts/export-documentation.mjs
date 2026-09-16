// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'vite';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../../backend/app/data/product-documentation.json', import.meta.url);
const dom = new JSDOM('', { url: 'http://localhost' });
globalThis.DOMParser = dom.window.DOMParser;
globalThis.localStorage = dom.window.localStorage;
globalThis.document = dom.window.document;
globalThis.window = dom.window;
dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
// This SSR alias differs from the app config. Sharing its optimizer cache can
// replace React chunks underneath a running Vite app, even for --check.
const cacheDir = await mkdtemp(join(tmpdir(), 'backplane-docs-vite-'));
let server;
try {
  server = await createServer({
    root,
    cacheDir,
    server: { middlewareMode: true },
    appType: 'custom',
    resolve: {
      alias: {
        'react-router-dom': fileURLToPath(new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url)),
      },
    },
  });
  const { exportDocumentation } = await server.ssrLoadModule('/src/pages/documentation/agent-export.tsx');
  const corpus = await exportDocumentation();
  const version = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
  const serialized = JSON.stringify({ version, ...corpus }, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8') !== serialized) throw new Error('Product documentation artifact is stale. Run pnpm docs:export.');
  } else await writeFile(output, serialized);
  console.log(`Product documentation: ${version} (${Object.keys(corpus.locales).length} locales)`);
} finally {
  try {
    await server?.close();
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
    dom.window.close();
  }
}
