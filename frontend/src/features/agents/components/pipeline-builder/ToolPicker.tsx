// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { RichTooltip } from "@/components/ui/rich-tooltip";
import { cn } from "@/lib/utils";
import {
  CLAUDE_BUILTINS,
  VALARIS_MCP_TOOLS,
  categorizeTool,
  lookupTool,
  type ToolCategory,
  type ToolEntry,
} from "../../lib/toolCatalog";

interface Props {
  value: string[];
  onChange: (tools: string[]) => void;
  id?: string;
}

type GroupKey = ToolCategory;

const GROUP_ORDER: GroupKey[] = ["claude_builtin", "valaris_mcp", "other"];

const GROUP_I18N: Record<GroupKey, { title: string; tooltip: string }> = {
  claude_builtin: {
    title: "pipelineBuilder.llm.toolPicker.groups.claudeBuiltins.title",
    tooltip: "pipelineBuilder.llm.toolPicker.groups.claudeBuiltins",
  },
  valaris_mcp: {
    title: "pipelineBuilder.llm.toolPicker.groups.valarisMcp.title",
    tooltip: "pipelineBuilder.llm.toolPicker.groups.valarisMcp",
  },
  other: {
    title: "pipelineBuilder.llm.toolPicker.groups.other.title",
    tooltip: "pipelineBuilder.llm.toolPicker.groups.other",
  },
};

export function ToolPicker({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [customInput, setCustomInput] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<GroupKey, boolean>>({
    claude_builtin: true,
    valaris_mcp: false,
    other: true,
  });

  const selectedSet = useMemo(() => new Set(value), [value]);

  const filteredBuiltins = filterTools(CLAUDE_BUILTINS, query, t);
  const filteredValaris = filterTools(VALARIS_MCP_TOOLS, query, t);

  const customSelected = useMemo(
    () => value.filter((id) => !lookupTool(id)),
    [value],
  );

  function toggle(id: string) {
    if (selectedSet.has(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  }

  function addCustom() {
    const raw = customInput.trim();
    if (!raw || selectedSet.has(raw)) {
      setCustomInput("");
      return;
    }
    onChange([...value, raw]);
    setCustomInput("");
  }

  function handleCustomKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustom();
    }
  }

  function toggleGroup(key: GroupKey) {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div id={id} className="space-y-3">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((toolId) => {
            const category = categorizeTool(toolId);
            const known = lookupTool(toolId);
            const badge = (
              <Badge
                variant={category === "other" ? "outline" : "secondary"}
                className="gap-1 pr-1 normal-case tracking-normal"
              >
                <span className="font-mono text-[0.7rem]">{known?.label ?? toolId}</span>
                <button
                  type="button"
                  onClick={() => toggle(toolId)}
                  aria-label={t("pipelineBuilder.llm.toolPicker.remove", {
                    tool: known?.label ?? toolId,
                  })}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
            // Unknown / custom tool ids don't have a summary in the catalog;
            // fall back to the generic toolBadge tooltip key so keyboard users
            // always get context, not just a bare id.
            const summaryOverride = known ? t(known.summaryKey) : undefined;
            return (
              <RichTooltip
                key={toolId}
                i18nKey="pipelineBuilder.llm.toolPicker.groups.toolBadge"
                summary={summaryOverride}
                side="top"
              >
                {badge}
              </RichTooltip>
            );
          })}
        </div>
      ) : null}

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("pipelineBuilder.llm.toolPicker.searchPlaceholder")}
        className="text-xs"
      />

      {GROUP_ORDER.map((key) => {
        const { title: titleKey, tooltip: tooltipKey } = GROUP_I18N[key];
        const groupTools =
          key === "claude_builtin"
            ? filteredBuiltins
            : key === "valaris_mcp"
              ? filteredValaris
              : [];
        // When a query is active, auto-expand any group that has matches so
        // the user doesn't have to manually open every collapsed section to
        // discover where their hits are. Empty groups stay collapsed.
        const hasMatches = key === "other" ? customSelected.length > 0 : groupTools.length > 0;
        const isOpen = (query.trim() !== "" && hasMatches) || openGroups[key];
        const selectedInGroup =
          key === "other"
            ? customSelected.length
            : groupTools.filter((tool) => selectedSet.has(tool.id)).length;
        const totalInGroup = key === "other" ? customSelected.length : groupTools.length;

        return (
          <div key={key} className="rounded-[var(--radius-md)] border border-border/70 bg-surface-1/40">
            <button
              type="button"
              onClick={() => toggleGroup(key)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold"
              aria-expanded={isOpen}
            >
              <span className="flex items-center gap-2">
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {t(titleKey)}
                <RichTooltip i18nKey={tooltipKey}>
                  <span
                    aria-hidden
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border/70 text-[0.6rem] text-muted-foreground"
                  >
                    ?
                  </span>
                </RichTooltip>
              </span>
              <span className="text-[0.7rem] font-normal text-muted-foreground">
                {selectedInGroup}/{totalInGroup || "—"}
              </span>
            </button>
            {isOpen ? (
              <div className="border-t border-border/60 px-2 py-2">
                {key === "other" ? (
                  <OtherGroup
                    selected={customSelected}
                    input={customInput}
                    onInputChange={setCustomInput}
                    onAdd={addCustom}
                    onRemove={toggle}
                    onInputKeyDown={handleCustomKey}
                  />
                ) : groupTools.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground">
                    {t("pipelineBuilder.llm.toolPicker.noMatches")}
                  </p>
                ) : (
                  <ul className="flex flex-col">
                    {groupTools.map((tool) => (
                      <ToolRow
                        key={tool.id}
                        tool={tool}
                        summary={t(tool.summaryKey)}
                        checked={selectedSet.has(tool.id)}
                        onToggle={() => toggle(tool.id)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ToolRow({
  tool,
  summary,
  checked,
  onToggle,
}: {
  tool: ToolEntry;
  summary: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={cn(
          "flex cursor-pointer items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs hover:bg-muted/40",
          checked && "bg-primary/8",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-[3px] h-3.5 w-3.5 accent-primary"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-[0.72rem] font-medium">{tool.label}</span>
          <span className="text-[0.7rem] leading-snug text-muted-foreground">
            {summary}
          </span>
        </span>
      </label>
    </li>
  );
}

function OtherGroup({
  selected,
  input,
  onInputChange,
  onAdd,
  onRemove,
  onInputKeyDown,
}: {
  selected: string[];
  input: string;
  onInputChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onInputKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 px-1 py-1">
      {selected.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {selected.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-muted/30 px-2 py-1"
            >
              <span className="font-mono text-[0.72rem]">{id}</span>
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t("pipelineBuilder.llm.toolPicker.remove", { tool: id })}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("pipelineBuilder.llm.toolPicker.groups.other.empty")}
        </p>
      )}
      <div className="flex gap-1.5">
        <Input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={t("pipelineBuilder.llm.toolPicker.groups.other.placeholder")}
          className="text-xs font-mono"
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!input.trim()}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border/70 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/40 disabled:opacity-50"
          aria-label={t("pipelineBuilder.llm.toolPicker.groups.other.add")}
        >
          <Plus className="h-3 w-3" />
          {t("common.add")}
        </button>
      </div>
    </div>
  );
}

function filterTools(
  tools: ToolEntry[],
  query: string,
  translate: (key: string) => string,
): ToolEntry[] {
  if (!query.trim()) return tools;
  const q = query.trim().toLowerCase();
  return tools.filter(
    (tool) =>
      tool.label.toLowerCase().includes(q) ||
      tool.id.toLowerCase().includes(q) ||
      translate(tool.summaryKey).toLowerCase().includes(q),
  );
}
