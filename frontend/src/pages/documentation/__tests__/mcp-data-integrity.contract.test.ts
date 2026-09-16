// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_TOOL_DOCS } from '../mcp-reference/data/knowledge';
import { CARDS_WORK_TOOL_DOCS } from '../mcp-reference/data/cards-work';
import { LOCALIZED_SECTION_TRANSLATIONS } from '../section-registry';

describe('MCP note pagination and bulk creation documentation', () => {
  it('documents bounded note defaults, composable filters, and the response envelope', () => {
    const doc = KNOWLEDGE_TOOL_DOCS.find(d => d.name === 'list_notes')!;
    expect(doc.params.map(p => p.name)).toEqual(['workspace_slug', 'board_id', 'card_id', 'summary_only', 'q', 'pinned_only', 'kinds', 'limit', 'offset']);
    const copy = JSON.stringify(doc);
    for (const token of ['default: true', 'default: 25', '1–100', 'next_offset', 'has_more', 'total', 'live', 'requires board_id']) expect(copy).toContain(token);
    expect(copy).not.toContain('silently ignores');
  });
  it('documents atomic repository validation without claiming single-create changes', () => {
    const doc = CARDS_WORK_TOOL_DOCS.find(d => d.name === 'bulk_create_cards')!;
    const copy = JSON.stringify(doc);
    for (const token of ['git_repo_slug', '422', 'entire batch']) expect(copy).toContain(token);
    expect(copy).not.toContain('silently ignored');
  });
  it('translates every narrative string in both updated tool references', () => {
    for (const doc of [KNOWLEDGE_TOOL_DOCS.find(d => d.name === 'list_notes')!, CARDS_WORK_TOOL_DOCS.find(d => d.name === 'bulk_create_cards')!]) {
      for (const locale of ['es', 'pt-BR'] as const) {
        const translations = LOCALIZED_SECTION_TRANSLATIONS[locale]['mcp-tool-catalog']!;
        for (const source of [doc.description, ...doc.params.map(p => p.description), ...(doc.gotchas ?? [])]) {
          expect(translations[source], `${locale}: ${source}`).toBeTruthy();
          expect(translations[source], `${locale}: untranslated ${source}`).not.toBe(source);
        }
      }
    }
  });
});
