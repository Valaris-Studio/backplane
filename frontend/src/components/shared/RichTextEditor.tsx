// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Suspense, lazy } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { RichTextEditorProps } from "./RichTextEditorImpl";

// tiptap (@tiptap/*) + markdown-it (via editor-utils' parseContent) are heavy
// and only needed once a user actually opens an editor (card/note/definition
// edit). Splitting the implementation behind lazy() keeps the whole editor
// stack out of the main bundle — every route imports `RichTextEditor` from this
// same path, so one boundary covers all consumers and existing test mocks of
// "@/components/shared/RichTextEditor" still resolve here.
const RichTextEditorImpl = lazy(() => import("./RichTextEditorImpl"));

export function RichTextEditor(props: RichTextEditorProps) {
  return (
    <Suspense
      fallback={
        <Skeleton
          className={props.className ?? "min-h-[120px] w-full"}
          aria-hidden
        />
      }
    >
      <RichTextEditorImpl {...props} />
    </Suspense>
  );
}

export type { RichTextEditorProps };
