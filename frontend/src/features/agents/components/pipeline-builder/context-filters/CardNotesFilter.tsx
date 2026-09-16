// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CARD_NOTE_KINDS } from "../../../lib/contextSourceCatalog";

interface Props {
  value: string;
  onChange: (next: string) => void;
  id?: string;
}

const ANY_KIND_SENTINEL = "__any__";

export function CardNotesFilter({ value, onChange, id }: Props) {
  const { t } = useTranslation();
  // Radix Select forbids empty-string values. Map "" (no filter) to a sentinel
  // for the dropdown only; emit "" through onChange so the wire shape stays
  // `{ filter: { kind: "" } }` -> backend treats missing/empty as "any kind".
  const selectValue = value === "" ? ANY_KIND_SENTINEL : value;
  return (
    <Select
      value={selectValue}
      onValueChange={(v) => onChange(v === ANY_KIND_SENTINEL ? "" : v)}
    >
      <SelectTrigger id={id} className="h-9 text-xs">
        <SelectValue>
          {value || t("pipelineBuilder.llm.contextSources.filter.cardNotes.anyKind")}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY_KIND_SENTINEL}>
          {t("pipelineBuilder.llm.contextSources.filter.cardNotes.anyKind")}
        </SelectItem>
        {CARD_NOTE_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {kind}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
