// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import Image from "@tiptap/extension-image";
import { isSafeMediaUrl, resolveMediaSrc, toStoredMediaSrc } from "@/lib/media-src";

/**
 * Image whose stored `src` stays the relative stable media path while the DOM
 * requests it through the API base — the two directions are exact inverses, so
 * an editor copy/paste on a split-origin host round-trips to the stored form.
 */
export const MediaImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => toStoredMediaSrc(element.getAttribute("src")),
        // An unsafe stored src renders as no src at all, never as the URL.
        renderHTML: (attributes: Record<string, unknown>) => ({
          src: isSafeMediaUrl(attributes.src) ? resolveMediaSrc(attributes.src) : null,
        }),
      },
    };
  },
});
