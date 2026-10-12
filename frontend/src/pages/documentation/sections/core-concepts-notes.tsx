// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content verified against backend/app/services/notes/content_normalizer.py and
// content_serializer.py (accepted inputs, markdown round trip),
// media_markdown.py (the image/attachment markdown form), notes/note.py
// (append and section semantics), media/links.py (stable link canonicalisation)
// and mcp-server/src/valaris_mcp/tools/notes.py + resources.py (the MCP surface).

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  HonestRemark,
  ImportantNote,
  ProTip,
} from "../callouts";

export function CoreConceptsNotes() {
  return (
    <SectionPage title="Notes" eyebrow="Core Concepts">
      <p>
        A <strong>note</strong> is a titled rich-text document that lives in a
        workspace or on a board, optionally linked to one card. People write
        notes in the shared editor; agents write them over MCP. Both edit the
        same stored document, so this chapter covers what that document can
        hold and how to change it without losing anything.
      </p>

      <h2 id="what-the-editor-supports">What the editor supports</h2>
      <p>
        The editor and the API share one closed vocabulary: headings (levels
        1–3), paragraphs, bold, italic, strikethrough, inline code, links,
        bullet and numbered lists, block quotes, horizontal rules, tables,
        code blocks with a language, Mermaid diagrams, mentions, images and
        file attachments. A Mermaid diagram is an ordinary code block whose
        language is <code>mermaid</code>; the editor draws it in place.
      </p>

      <h2 id="markdown-vs-prosemirror">Markdown vs ProseMirror</h2>
      <p>
        Every note is stored as ProseMirror JSON, the editor&apos;s native
        format. Writes accept more than that: <code>content</code> may be
        Markdown, HTML, plain text or ProseMirror JSON, and the server converts
        it to the stored form on every save. Markdown is the right default for
        agents — it is compact and readable.
      </p>
      <p>
        Reads go the other way. <code>get_note</code> returns the raw JSON by
        default; pass <code>format=&quot;markdown&quot;</code> to get the same
        document serialized to Markdown, which costs far fewer tokens. The
        conversion is a read-time projection — nothing stored changes.
      </p>

      <h2 id="editing-over-mcp">Editing a note over MCP</h2>
      <p>
        <code>create_note</code> takes a <code>title</code> and an optional{" "}
        <code>content</code>, plus <code>board_id</code> for a board note and{" "}
        <code>card_id</code> to link a card. <code>update_note</code> changes
        only the fields you pass, and its <code>mode</code> decides what{" "}
        <code>content</code> does:
      </p>
      <ul>
        <li>
          <code>replace</code> (the default) — the new content becomes the
          whole body.
        </li>
        <li>
          <code>append</code> — the new blocks go after the existing ones. It
          is not idempotent: a retried call appends a second copy.
        </li>
        <li>
          <code>section</code> — rewrites one section, named by{" "}
          <code>anchor_heading</code>. The heading itself is kept; the section
          runs until the next heading at the same or a higher level, so
          subsections stay inside it. Matching ignores case and surrounding
          spaces, and a heading that appears twice is refused rather than
          guessed. Replaying the same call converges, so it is safe to retry.
        </li>
      </ul>
      <CodeExample language="text" title="Rewrite one section of a tracker note">
        {`update_note(
  workspace_slug="acme",
  note_id="3f9c2a10",
  mode="section",
  anchor_heading="Open questions",
  content="- Who signs off the rollout?\\n- Do we keep the v1 endpoint?"
)`}
      </CodeExample>

      <h2 id="large-notes">Large notes: append in chunks</h2>
      <p>
        The server sets no size limit on a note; the practical ceiling is how
        much one tool call can carry. To write a long document, create the
        note with its first part, then add the rest with{" "}
        <code>update_note</code> and <code>mode=&quot;append&quot;</code>, one
        section per call. Content is always sent inline — there is no
        upload-a-file-as-a-note shortcut.
      </p>
      <ImportantNote title="Append is not idempotent">
        If an append call fails ambiguously, read the note before retrying.
        Retrying blindly can leave the same chunk in the note twice.
      </ImportantNote>

      <h2 id="images-and-attachments">Images and attachments</h2>
      <p>
        A note never stores a short-lived signed link: it would break for every
        reader within the hour. It stores a stable, authenticated app path
        instead — <code>/api/workspaces/&#123;slug&#125;/media/…</code> for
        images pasted in the editor, <code>/api/workspaces/&#123;slug&#125;/resources/&#123;id&#125;/content</code>{" "}
        for uploaded files. Each read checks the reader&apos;s access before
        serving the file. A signed storage URL for one of this
        workspace&apos;s files that reaches a save is rewritten to its stable
        path before it is stored.
      </p>
      <p>
        To add a file from MCP, call <code>upload_resource</code>. It uploads
        the bytes and registers the file in one call. Its result carries{" "}
        <code>content_url</code>, the stable link to embed, and{" "}
        <code>embed_markdown</code>, the Markdown line to paste into a note.
        For a file that already exists, <code>get_download_url</code> returns
        the same <code>content_url</code>.
      </p>
      <CodeExample language="text" title="Upload a screenshot and embed it">
        {`upload_resource(workspace_slug="acme", path="screenshots/login.png")
→ content_url:    /api/workspaces/acme/resources/9b1e4c7a-…/content
  embed_markdown: ![login.png](/api/workspaces/acme/resources/9b1e4c7a-…/content)

update_note(
  workspace_slug="acme",
  note_id="3f9c2a10",
  mode="append",
  content="![login.png](/api/workspaces/acme/resources/9b1e4c7a-…/content)"
)`}
      </CodeExample>
      <p>
        <code>path</code> reads a local file and works only when the server
        runs over stdio. Over HTTP, send the bytes as{" "}
        <code>content_base64</code>. The tool reference lists the size caps
        and the paths it refuses.
      </p>
      <p>Embed the link in Markdown with one of these two forms:</p>
      <CodeExample language="markdown" title="Image and attachment Markdown">
        {`![Login screen](/api/workspaces/acme/resources/9b1e4c7a-2d4f-4f8e-9a51-3c0d7e2b6f10/content "Step 1")

[spec sheet.pdf](/api/workspaces/acme/resources/4c2d8e1f-7a3b-4b6c-8d2e-5f1a9c3b7e40/content "attachment; size=48213; type=application/pdf")`}
      </CodeExample>
      <p>
        An image is standard Markdown; the quoted title is optional. An
        attachment is a link whose title starts with <code>attachment</code>,
        optionally followed by <code>size=</code> (bytes) and{" "}
        <code>type=</code> (a MIME type), and it must stand alone as its own
        paragraph. The same link inside a sentence, or with any other title,
        stays an ordinary link. HTML input follows the same rules:{" "}
        <code>&lt;img&gt;</code> becomes an image, and a paragraph holding only
        an <code>&lt;a&gt;</code> with an attachment title becomes an
        attachment.
      </p>

      <h2 id="round-trip-guarantees">Round-trip guarantees</h2>
      <p>
        Reading a note as Markdown, editing the text and writing it back keeps
        the document intact: headings, marks, links, lists, quotes, rules,
        tables, code blocks and Mermaid diagrams, images with their alt text
        and title, and attachments with their name, size and type all come
        back as the same nodes, at the same stable paths.
      </p>
      <HonestRemark title="What Markdown cannot carry">
        A mention becomes plain @Name text, a table cell is flattened to one
        line, and table column alignment is dropped. Headings deeper than
        level 3 are stored as level 3. An attachment whose upload never
        finished has no link and comes back as its bare file name. Markdown
        checklists are not converted yet. When a note holds mentions you need
        to keep, edit it with <code>mode=&quot;section&quot;</code> around them
        or write ProseMirror JSON.
      </HonestRemark>
      <ProTip title="Edit the smallest piece you can">
        Prefer <code>mode=&quot;section&quot;</code> over replacing a whole
        note. It touches only the section you name, so anything outside it —
        including what Markdown cannot carry — is left exactly as it was.
      </ProTip>
    </SectionPage>
  );
}
