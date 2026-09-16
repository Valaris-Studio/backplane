// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEditor, EditorContent } from "@tiptap/react";
import { toast } from "sonner";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Minus,
  Workflow,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  Paperclip,
} from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { Separator } from "@/components/ui/separator";
import { useImageUpload } from "@/hooks/useImageUpload";
import { useFileUpload } from "@/hooks/useFileUpload";
import { FileAttachment } from "@/extensions/file-attachment";
import { MermaidCodeBlock } from "@/extensions/mermaid-code-block";
import { Mention } from "@/components/shared/editor/mention-extension";
import { htmlWinsClipboard, cleanPastedHtml } from "@/components/shared/editor/paste-rules";
import { useMentionPicker } from "@/components/shared/editor/use-mention-picker";
import { cn } from "@/lib/utils";
import { parseContent, looksLikeMarkdown } from "@/lib/editor-utils";
import type { EditorView } from "@tiptap/pm/view";
import type { EditorState } from "@tiptap/pm/state";

export interface RichTextEditorProps {
  content: string;
  onChange: (json: string) => void;
  placeholder?: string;
  editable?: boolean;
  workspaceSlug?: string;
  className?: string;
  toolbarClassName?: string;
}

/**
 * Turn a text/plain clipboard that looks like markdown into real nodes.
 *
 * Agent and terminal output arrives with no text/html, so ProseMirror would
 * otherwise insert `## Result` + a bullet list as literal source text. Returns
 * true only when it consumed the paste.
 */
function pasteMarkdownFromClipboard(view: EditorView, event: ClipboardEvent): boolean {
  // Inside a code block the pasted text IS the content — parsing it would
  // insert the heading/list as siblings AFTER the block, silently breaking
  // out of the fence. ProseMirror's default literal insert is correct there.
  if (isInCodeBlock(view.state)) return false;
  // Belt-and-braces for the P0-2 html path: htmlWinsClipboard already returned
  // false above for real html, but never let markdown outrank a richer payload.
  if (event.clipboardData?.getData("text/html")) return false;

  const text = event.clipboardData?.getData("text/plain");
  if (!text || !looksLikeMarkdown(text)) return false;

  // No preventDefault() here: prosemirror-view calls it itself whenever
  // handlePaste returns true (view/dist/index.js editHandlers.paste).
  const { schema, tr } = view.state;
  const doc = schema.nodeFromJSON(parseContent(text));
  view.dispatch(tr.replaceSelectionWith(doc, false).scrollIntoView());
  return true;
}

function isInCodeBlock(state: EditorState): boolean {
  const codeBlock = state.schema.nodes.codeBlock;
  if (!codeBlock) return false;
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === codeBlock) return true;
  }
  return $to.parent.type === codeBlock;
}

export function RichTextEditor({
  content,
  onChange,
  placeholder,
  editable = true,
  workspaceSlug,
  className,
  toolbarClassName,
}: RichTextEditorProps) {
  const { t } = useTranslation();
  const { uploadImage, isUploading } = useImageUpload(workspaceSlug ?? "");
  const { uploadFile, isUploading: isUploadingFile } = useFileUpload(workspaceSlug ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  // The ONE wiring point: registering Mention here gives both card descriptions
  // (CardDetailSheet) and note content (NoteEditor) the @mention primitive,
  // since both route through this shared editor with workspaceSlug.
  const { buildRenderer, pickerElement } = useMentionPicker(workspaceSlug);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
        // Replaced by MermaidCodeBlock below — same "codeBlock" node, extra
        // view. Both registered would collide on the node name.
        codeBlock: false,
      }),
      MermaidCodeBlock,
      Image.configure({ inline: false }),
      Placeholder.configure({
        placeholder: placeholder ?? t("editor.placeholder"),
      }),
      Link.configure({
        openOnClick: !editable,
        autolink: true,
      }),
      FileAttachment,
      Mention.configure({ buildRenderer }),
      Table,
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: parseContent(content),
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      onChange(JSON.stringify(editor.getJSON()));
    },
    editorProps: {
      attributes: {
        class: "tiptap-editor focus:outline-none",
      },
      transformPastedHTML: (html) => cleanPastedHtml(html),
      handlePaste: (view, event) => {
        // Word/GDocs ship a PNG rendition alongside the real text/html —
        // returning false lets ProseMirror parse the html instead of uploading it.
        if (event.clipboardData && htmlWinsClipboard(event.clipboardData)) return false;
        const items = event.clipboardData?.items;
        // Markdown branch runs BEFORE the workspaceSlug gate below: that gate
        // exists for uploads, and pasting markdown needs no workspace.
        if (pasteMarkdownFromClipboard(view, event)) return true;
        if (!items || !workspaceSlug) return false;
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) handleImageFile(file);
            return true;
          }
        }
        // Check for non-image files (e.g. from file manager paste)
        for (const item of items) {
          if (item.kind === "file" && !item.type.startsWith("image/")) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) handleAttachmentFile(file);
            return true;
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        // Decision on types only — the html payload is unreadable pre-drop in
        // some browsers, so an html-carrying drop always goes to ProseMirror.
        if (event.dataTransfer?.types.includes("text/html")) return false;
        const files = event.dataTransfer?.files;
        if (!files?.length || !workspaceSlug) return false;
        for (const file of files) {
          if (file.type.startsWith("image/")) {
            event.preventDefault();
            handleImageFile(file);
            return true;
          }
        }
        // Non-image files become attachments
        for (const file of files) {
          if (!file.type.startsWith("image/")) {
            event.preventDefault();
            handleAttachmentFile(file);
            return true;
          }
        }
        return false;
      },
    },
  });

  // Sync external content changes (e.g. when switching between notes)
  const lastContentRef = useRef(content);
  useEffect(() => {
    if (!editor || content === lastContentRef.current) return;
    lastContentRef.current = content;
    const currentJson = JSON.stringify(editor.getJSON());
    if (currentJson !== content) {
      // emitUpdate: false — an external sync is not a user edit. Letting it
      // emit routes TipTap's own re-serialization (default attrs, key order)
      // into onChange, which diverges from the backend-canonical PM JSON and
      // trips every string-compare dirty check upstream (false-dirty Save on
      // open, phantom unsaved-changes prompts, blind saves rewriting rows).
      editor.commands.setContent(parseContent(content), { emitUpdate: false });
    }
  }, [editor, content]);

  const handleImageFile = useCallback(
    async (file: File) => {
      if (!editor || !workspaceSlug) return;
      try {
        const url = await uploadImage(file);
        editor.chain().focus().setImage({ src: url, alt: file.name }).run();
      } catch {
        toast.error(t("editor.imageUploadError"));
      }
    },
    [editor, uploadImage, workspaceSlug, t],
  );

  const handleAttachmentFile = useCallback(
    async (file: File) => {
      if (!editor || !workspaceSlug) return;

      // Insert placeholder node
      editor
        .chain()
        .focus()
        .setFileAttachment({
          filename: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
          uploading: true,
        })
        .run();

      // Find the placeholder node we just inserted
      const placeholderPos = findUploadingNode(editor);

      try {
        const result = await uploadFile(file);
        if (placeholderPos !== null) {
          const { tr } = editor.state;
          const node = tr.doc.nodeAt(placeholderPos);
          if (node?.type.name === "fileAttachment") {
            tr.setNodeMarkup(placeholderPos, undefined, {
              ...node.attrs,
              src: result.url,
              uploading: false,
            });
            editor.view.dispatch(tr);
          }
        }
      } catch (err) {
        // Remove placeholder on failure
        if (placeholderPos !== null) {
          const { tr } = editor.state;
          const node = tr.doc.nodeAt(placeholderPos);
          if (node?.type.name === "fileAttachment") {
            tr.delete(placeholderPos, placeholderPos + node.nodeSize);
            editor.view.dispatch(tr);
          }
        }
        if (err instanceof Error && err.message === "FILE_TOO_LARGE") {
          alert(t("editor.fileTooLarge"));
        }
      }
    },
    [editor, uploadFile, workspaceSlug, t],
  );

  function handleImageButton() {
    fileInputRef.current?.click();
  }

  function handleAttachmentButton() {
    attachmentInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleImageFile(file);
    e.target.value = "";
  }

  function handleAttachmentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleAttachmentFile(file);
    e.target.value = "";
  }

  function handleLinkButton() {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt(t("editor.linkUrlPrompt"), previousUrl);
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  // Seeded with a minimal valid flowchart: an empty mermaid block renders
  // nothing, which reads as a broken feature rather than an empty canvas.
  function insertMermaidBlock() {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertContent({
        type: "codeBlock",
        attrs: { language: "mermaid" },
        content: [{ type: "text", text: "flowchart TD\n  A[Start] --> B[End]" }],
      })
      .run();
  }

  if (!editor) return null;

  return (
    <div
      className={cn(
        "flex flex-col rounded-md border border-input bg-background",
        className,
      )}
    >
      {editable && (
        <div
          role="toolbar"
          aria-label={t("editor.toolbar")}
          className={cn(
            "sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-[inherit] border-b border-border/70 bg-background/95 px-2 py-1.5 backdrop-blur",
            toolbarClassName,
          )}
        >
          <Toggle
            size="sm"
            pressed={editor.isActive("bold")}
            onPressedChange={() => editor.chain().focus().toggleBold().run()}
            aria-label={t("editor.bold")}
            title={t("editor.bold")}
          >
            <Bold className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("italic")}
            onPressedChange={() => editor.chain().focus().toggleItalic().run()}
            aria-label={t("editor.italic")}
            title={t("editor.italic")}
          >
            <Italic className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("strike")}
            onPressedChange={() => editor.chain().focus().toggleStrike().run()}
            aria-label={t("editor.strike")}
            title={t("editor.strike")}
          >
            <Strikethrough className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("code")}
            onPressedChange={() => editor.chain().focus().toggleCode().run()}
            aria-label={t("editor.code")}
            title={t("editor.code")}
          >
            <Code className="h-4 w-4" />
          </Toggle>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <Toggle
            size="sm"
            pressed={editor.isActive("heading", { level: 1 })}
            onPressedChange={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            aria-label={t("editor.h1")}
            title={t("editor.h1")}
          >
            <Heading1 className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("heading", { level: 2 })}
            onPressedChange={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            aria-label={t("editor.h2")}
            title={t("editor.h2")}
          >
            <Heading2 className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("heading", { level: 3 })}
            onPressedChange={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            aria-label={t("editor.h3")}
            title={t("editor.h3")}
          >
            <Heading3 className="h-4 w-4" />
          </Toggle>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <Toggle
            size="sm"
            pressed={editor.isActive("bulletList")}
            onPressedChange={() => editor.chain().focus().toggleBulletList().run()}
            aria-label={t("editor.bulletList")}
            title={t("editor.bulletList")}
          >
            <List className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("orderedList")}
            onPressedChange={() => editor.chain().focus().toggleOrderedList().run()}
            aria-label={t("editor.orderedList")}
            title={t("editor.orderedList")}
          >
            <ListOrdered className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("blockquote")}
            onPressedChange={() => editor.chain().focus().toggleBlockquote().run()}
            aria-label={t("editor.blockquote")}
            title={t("editor.blockquote")}
          >
            <Quote className="h-4 w-4" />
          </Toggle>

          <Separator orientation="vertical" className="mx-1 h-5" />

          <Toggle
            size="sm"
            pressed={false}
            onPressedChange={() => editor.chain().focus().setHorizontalRule().run()}
            aria-label={t("editor.horizontalRule")}
            title={t("editor.horizontalRule")}
          >
            <Minus className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={false}
            onPressedChange={insertMermaidBlock}
            aria-label={t("editor.mermaid")}
            title={t("editor.mermaid")}
          >
            <Workflow className="h-4 w-4" />
          </Toggle>
          <Toggle
            size="sm"
            pressed={editor.isActive("link")}
            onPressedChange={handleLinkButton}
            aria-label={t("editor.link")}
            title={t("editor.link")}
          >
            <LinkIcon className="h-4 w-4" />
          </Toggle>

          {workspaceSlug && (
            <>
              <Toggle
                size="sm"
                pressed={false}
                onPressedChange={handleImageButton}
                disabled={isUploading}
                aria-label={t("editor.uploadImage")}
                title={t("editor.uploadImage")}
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImageIcon className="h-4 w-4" />
                )}
              </Toggle>
              <Toggle
                size="sm"
                pressed={false}
                onPressedChange={handleAttachmentButton}
                disabled={isUploadingFile}
                aria-label={t("editor.attachFile")}
                title={t("editor.attachFile")}
              >
                {isUploadingFile ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </Toggle>
            </>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={attachmentInputRef}
            type="file"
            className="hidden"
            onChange={handleAttachmentChange}
          />
        </div>
      )}

      <EditorContent
        editor={editor}
        // flex column + flex-1 so the editable region fills the shell's height
        // (consumers set the outer min-height, e.g. NoteEditor's min-h-[240px]).
        // Without this the area below the 120px floor is dead space on the
        // non-editable root and clicks there never focus the editor. The inner
        // .tiptap-editor (the contenteditable) is stretched via CSS to fill this
        // wrapper so the whole box — not just its first line — is a click target.
        className={cn(
          "flex min-h-[120px] flex-1 flex-col px-3 py-2 text-sm",
          !editable && "cursor-default",
        )}
      />
      {pickerElement}
    </div>
  );
}

// Default export so the lazy wrapper can `import()` this module without a
// `.then` re-map. The named export stays for tests that import it directly.
export default RichTextEditor;

/** Find the first fileAttachment node that has uploading=true */
function findUploadingNode(editor: ReturnType<typeof useEditor>): number | null {
  if (!editor) return null;
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "fileAttachment" && node.attrs.uploading) {
      found = pos;
      return false;
    }
  });
  return found;
}
