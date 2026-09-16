// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
// Build-time adapter only: the JSX corpus and the explorer remain canonical.
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '@/i18n/supported-languages';
import { getDocSections } from './routes';
import { resolveDocumentationSection } from './section-registry';
import { DocumentationSectionTranslationProvider } from './section-localization';
import { DocumentationSectionTitleProvider } from './section-title-context';
import { DetailPane, type ResolvedSelection } from './mcp-reference/DetailPane';
import { TOOL_DOCS, PROMPT_DOCS, RESOURCE_DOCS } from './mcp-reference/data';
export function htmlToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  function visit(node: Node): string {
    if (node.nodeType === 3)
      return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1)
      return '';
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' && element.hasAttribute('data-doc-technical')) {
      const name = element.textContent?.trim() ?? '';
      return `[${name}](#${element.getAttribute('data-selection') ?? `tool-${name}`}) `;
    }
    if (['svg', 'button', 'input', 'style', 'script'].includes(tag))
      return '';
    const children = () => Array.from(node.childNodes).map(visit).join('');
    const anchor = element.id ? `<a id="${element.id}"></a>\n` : '';
    if (tag === 'pre') {
      const code = element.querySelector('code');
      const text = element.textContent ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return `\n\n${fence}${code?.getAttribute('data-language') ?? ''}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
      const text = element.textContent ?? '';
      const fence = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
      return `${fence} ${text} ${fence}`;
    }
    if (/^h[1-6]$/.test(tag))
      return `\n\n${anchor}${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    if (tag === 'a')
      return `${anchor}[${children()}](${element.getAttribute('href') ?? ''})`;
    if (tag === 'img')
      return `![${element.getAttribute('alt') ?? ''}](${element.getAttribute('src') ?? ''})`;
    if (tag === 'br')
      return '\n';
    if (tag === 'strong' || tag === 'b')
      return `**${children()}**`;
    if (tag === 'em' || tag === 'i')
      return `*${children()}*`;
    if (element.hasAttribute('data-doc-table-columns')) {
      const width = Number(element.getAttribute('data-doc-table-columns'));
      const cells = Array.from(element.children).map(cell => visit(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>'));
      const rows: string[] = [];
      for (let i = 0; i < cells.length; i += width)
        rows.push('| ' + cells.slice(i, i + width).join(' | ') + ' |');
      rows.splice(1, 0, '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |');
      return '\n\n' + rows.join('\n') + '\n\n';
    }
    if (tag === 'table') {
      const rows = Array.from(element.querySelectorAll('tr')).map(row => '| ' + Array.from(row.children).map(cell => visit(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |');
      if (rows.length)
        rows.splice(1, 0, '| ' + Array.from(element.querySelector('tr')!.children).map(() => '---').join(' | ') + ' |');
      return '\n\n' + rows.join('\n') + '\n\n';
    }
    if (tag === 'aside' || tag === 'blockquote')
      return '\n\n' + ((element.getAttribute('data-callout') ? `[!${element.getAttribute('data-callout')!.toUpperCase()}]\n` : '') + children().trim()).split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    if (tag === 'li') {
      const marker = element.parentElement?.tagName === 'OL' ? '1. ' : '- ';
      return marker + children().trim().replace(/\n/g, '\n' + ' '.repeat(marker.length)) + '\n';
    }
    if (tag === 'ul' || tag === 'ol')
      return '\n\n' + children().trimEnd() + '\n\n';
    if (['p', 'div', 'section', 'article', 'header', 'figure', 'ul', 'ol', 'figcaption'].includes(tag))
      return `\n\n${anchor}${children()}\n\n`;
    return anchor + children();
  }
  // Do not normalize globally: whitespace inside code blocks is contractual.
  return Array.from(document.body.childNodes).map(visit).join('').trim() + '\n';
}
export async function exportDocumentation() {
  const locales: Record<string, Array<{
    slug: string;
    title: string;
    group: string;
    order: number;
    status: string;
    source_locale: string;
    content_locale: string;
    markdown: string;
  }>> = {};
  for (const locale of SUPPORTED_LANGUAGES) {
    const i18n = createInstance();
    await i18n.init({ lng: locale, resources: {}, initImmediate: false });
    locales[locale] = getDocSections(locale).map(section => {
      const resolved = resolveDocumentationSection(locale, section.slug)!;
      const { Component, translations, status } = resolved;
      const selections: ResolvedSelection[] = section.slug === 'mcp-tool-catalog' ? [
        ...TOOL_DOCS.map(tool => ({ kind: 'tool' as const, tool })),
        ...PROMPT_DOCS.map(prompt => ({ kind: 'prompt' as const, prompt })),
        ...RESOURCE_DOCS.map(resource => ({ kind: 'resource' as const, resource })),
      ] : [];
      const html = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <DocumentationSectionTranslationProvider translations={translations}>
            <DocumentationSectionTitleProvider title={section.title}>
              <MemoryRouter initialEntries={[`/documentation/${section.slug}`]}>
                <Component />
                {selections.map((selection, index) => (
                  <section
                    key={index}
                    id={selection.kind === "tool"
                      ? `tool-${selection.tool.name}`
                      : selection.kind === "prompt"
                        ? `prompt-${selection.prompt.name}`
                        : `resource-${selection.resource.uri}`}
                  >
                    <DetailPane resolved={selection} onSelectTool={() => {}} />
                  </section>
                ))}
              </MemoryRouter>
            </DocumentationSectionTitleProvider>
          </DocumentationSectionTranslationProvider>
        </I18nextProvider>,
      );
      return { ...section, status, source_locale: resolved.sourceLocale, content_locale: status === "translated" ? locale : resolved.sourceLocale, markdown: htmlToMarkdown(html) };
    });
  }
  return { schema_version: 1, locales };
}
