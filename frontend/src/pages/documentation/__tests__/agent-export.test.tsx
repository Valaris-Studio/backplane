// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { exportDocumentation, htmlToMarkdown } from '../agent-export';
import { SUPPORTED_LANGUAGES } from '@/i18n/supported-languages';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { resolveDocumentationSection, LOCALIZED_SECTION_TRANSLATIONS } from '../section-registry';
import { collectDocumentationTechnicalContract } from '../technical-contract';
import MarkdownIt from 'markdown-it';
import { DOC_SECTIONS } from '../routes';
vi.mock('@/hooks/use-reduced-motion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => true }));
describe('agent documentation export', () => {
  it('preserves anchors, code bytes, links, warnings and tables', () => {
    const markdown = htmlToMarkdown('<h2 id="safe">Safe</h2><aside><h3>Warning</h3><p>Keep keys private.</p></aside><pre><code data-language="sh">echo "a  b"\n</code></pre><a href="/documentation/x#y">Read</a><table><tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td>b</td></tr></table>');
    expect(markdown).toContain('<a id="safe"></a>');
    expect(markdown).toContain('echo "a  b"\n');
    expect(markdown).toContain('[Read](/documentation/x#y)');
    expect(markdown).toContain('> ### Warning');
    expect(markdown).toContain('| Key | Value |');
  });
  it('retains nested list structure and code pipes in tables', () => {
    const source = '<ul><li>Parent<ul><li>Child</li></ul></li></ul><table><tr><th>Code</th></tr><tr><td><code>a | b</code></td></tr></table>';
    const rendered = new MarkdownIt({ html: true }).render(htmlToMarkdown(source));
    const parsed = new DOMParser().parseFromString(rendered, 'text/html');
    expect(parsed.querySelector('li > ul > li')?.textContent).toBe('Child');
    expect(parsed.querySelector('td code')?.textContent).toBe('a | b');
  });
  it('reports English fallback explicitly when a locale registration is missing', async () => {
    const registry = LOCALIZED_SECTION_TRANSLATIONS.es as Record<string, Readonly<Record<string, string>>>;
    const original = registry['what-backplane-is']!;
    delete registry['what-backplane-is'];
    try {
      const corpus = await exportDocumentation();
      const section = corpus.locales.es!.find(s => s.slug === 'what-backplane-is')!;
      expect(section.status).toBe('missing');
      expect(section).toMatchObject({ source_locale: 'en', content_locale: 'en' });
    }
    finally {
      registry['what-backplane-is'] = original;
    }
  }, 30000);
  it('exports all registered locales and every dynamic MCP selection deterministically', async () => {
    const corpus = await exportDocumentation();
    expect(Object.keys(corpus.locales)).toEqual([...SUPPORTED_LANGUAGES]);
    for (const locale of SUPPORTED_LANGUAGES) {
      const sections = corpus.locales[locale]!;
      expect(sections).toHaveLength(DOC_SECTIONS.length);
      expect(sections.every(s => s.markdown.length > 50 && s.status !== 'missing')).toBe(true);
      const mcp = sections.find(s => s.slug === 'mcp-tool-catalog')!;
      expect(mcp.markdown).toContain('update_card');
      expect(mcp.markdown).toContain('due_date');
      expect(mcp.markdown).toContain('whoami');
      if (locale === 'en')
        expect(mcp.markdown).toContain('Every tool id follows');
      expect(mcp.markdown).toContain('](#tool-');
    }
    for (const { slug } of DOC_SECTIONS) {
      const { Component } = resolveDocumentationSection('en', slug)!;
      const sourceHtml = renderToStaticMarkup(<MemoryRouter><Component /></MemoryRouter>);
      const source = collectDocumentationTechnicalContract(new DOMParser().parseFromString(sourceHtml, 'text/html'));
      for (const locale of SUPPORTED_LANGUAGES) {
        const markdown = corpus.locales[locale]!.find(s => s.slug === slug)!.markdown;
        const rendered = new DOMParser().parseFromString(new MarkdownIt({ html: true }).render(markdown), 'text/html');
        const actual = collectDocumentationTechnicalContract(rendered);
        for (const anchor of source.anchors)
          expect(actual.anchors.includes(anchor), `${locale}:${slug} anchor ${anchor}`).toBe(true);
        for (const link of source.links)
          expect(actual.links.includes(link), `${locale}:${slug} link ${link}`).toBe(true);
        for (const code of source.codeBlocks)
          expect(actual.codeBlocks.some(c => c.trimEnd() === code.trimEnd()), `${locale}:${slug} code block ${code.slice(0, 50)}`).toBe(true);
        for (const code of source.inlineCode)
          expect(actual.inlineCode.includes(code), `${locale}:${slug} inline code ${code}`).toBe(true);
      }
    }
    expect(await exportDocumentation()).toEqual(corpus);
  }, 30000);
});
