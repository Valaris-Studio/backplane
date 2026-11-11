// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { usePromptsHidden } from "../hooks/use-hide-prompts";
import { utf8Range } from "../utils/find-ranges";
import { CallContentText } from "./PromptText";

export interface MatchRange { byteStart: number; byteEnd: number; offset: number }

export function SessionMatchText({ text, range }: { text: string; range?: MatchRange }) {
  const hidden = usePromptsHidden();
  const indices = range && utf8Range(text, range.byteStart, range.byteEnd, range.offset);
  if (hidden || !indices) return <CallContentText text={text} />;
  return <>{text.slice(0, indices[0])}<mark className="rounded-sm bg-amber-200 text-slate-950 dark:bg-amber-300">{text.slice(...indices)}</mark>{text.slice(indices[1])}</>;
}
