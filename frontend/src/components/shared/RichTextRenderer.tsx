// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { FileAttachment } from "@/extensions/file-attachment";
import { MermaidCodeBlock } from "@/extensions/mermaid-code-block";
import { Mention } from "@/components/shared/editor/mention-extension";
import { cn } from "@/lib/utils";
import { parseContent } from "@/lib/editor-utils";

interface RichTextRendererProps {
  content: string;
  className?: string;
}

export function RichTextRenderer({ content, className }: RichTextRendererProps) {
  const editor = useEditor({
    extensions: [
      // codeBlock is disabled here and re-added as MermaidCodeBlock so
      // read-only surfaces (card descriptions, note bodies) draw diagrams too.
      // This list has no mechanical link to the editor's — keep them in step.
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
        codeBlock: false,
      }),
      MermaidCodeBlock,
      Image.configure({ inline: false }),
      Link.configure({ openOnClick: true }),
      FileAttachment,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      // Display-only: renders mention chips identically; no buildRenderer ⇒ no
      // suggestion plugin (read-only view never opens the picker).
      Mention,
    ],
    content: parseContent(content),
    editable: false,
    immediatelyRender: false,
  });

  if (!editor) return null;

  return (
    <EditorContent
      editor={editor}
      className={cn("tiptap-editor text-sm", className)}
    />
  );
}
