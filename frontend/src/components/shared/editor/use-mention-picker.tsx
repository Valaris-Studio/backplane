// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useRef, useState } from "react";
import {
  MentionPicker,
  type MentionPickerController,
} from "./MentionPicker";
import type {
  MentionRenderProps,
  MentionSuggestionRenderer,
} from "./mention-suggestion-plugin";

interface ActiveSuggestion {
  query: string;
  clientRect: () => DOMRect | null;
  command: (attrs: { id: string; label: string }) => void;
}

/**
 * Bridges the imperative `@`-suggestion plugin to the React <MentionPicker>.
 * `buildRenderer` is handed to the Mention extension options; `pickerElement`
 * is rendered alongside <EditorContent>. Returns `null` renderer when no slug
 * (mentions need a workspace to search) so the editor stays mention-free.
 */
export function useMentionPicker(slug?: string) {
  const [active, setActive] = useState<ActiveSuggestion | null>(null);
  const controllerRef = useRef<MentionPickerController | null>(null);

  const buildRenderer = useCallback((): MentionSuggestionRenderer | null => {
    if (!slug) return null;
    const open = (props: MentionRenderProps) =>
      setActive({
        query: props.query,
        clientRect: props.clientRect,
        command: props.command,
      });
    return {
      onStart: open,
      onUpdate: open,
      onExit: () => setActive(null),
      onKeyDown: (event) => {
        if (event.key === "Escape") {
          setActive(null);
          return true;
        }
        return controllerRef.current?.onKeyDown(event) ?? false;
      },
    };
  }, [slug]);

  const pickerElement =
    slug && active ? (
      <MentionPicker
        slug={slug}
        query={active.query}
        clientRect={active.clientRect}
        controllerRef={controllerRef}
        onSelect={(attrs) => {
          active.command(attrs);
          setActive(null);
        }}
      />
    ) : null;

  return { buildRenderer, pickerElement };
}
