// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Captured content is untrusted evidence. It may format text, but it never
// fetches, runs or embeds anything: not MarkdownPreview, which renders <img>.
const SAFE_PROTOCOL = /^(https?|mailto):/i;

function safeUrl(url: string): string {
  return SAFE_PROTOCOL.test(url.trim()) ? url : "";
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

// Raw HTML is shown as the text it is, never parsed into elements.
function htmlAsText() {
  const visit = (node: MarkdownNode) => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(visit);
  };
  return visit;
}

// Soft breaks belong to captured prose; code nodes retain their exact bytes.
function proseLineBreaks() {
  const visit = (node: MarkdownNode) => {
    node.children = node.children?.flatMap((child) => {
      if (child.type !== "text" || !child.value?.includes("\n")) {
        visit(child);
        return [child];
      }
      return child.value.split("\n").flatMap((value, index) =>
        index ? [{ type: "break" }, { type: "text", value }] : [{ type: "text", value }],
      );
    });
  };
  return visit;
}

function OutboundLink({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => <OutboundLink href={href}>{children}</OutboundLink>,
  // An image becomes a link to its address, so nothing is fetched on view.
  img: ({ src, alt }) => <OutboundLink href={typeof src === "string" ? src : undefined}>{alt || src}</OutboundLink>,
};

// The app ships no typography plugin; these give captured markdown its structure.
const MARKDOWN_CLASSES = [
  "grid gap-2 break-words text-[0.92rem] leading-relaxed",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_h1]:text-[1.02rem] [&_h1]:font-bold [&_h2]:text-[0.98rem] [&_h2]:font-bold [&_h3]:font-semibold",
  "[&_a]:font-semibold [&_a]:underline [&_a]:underline-offset-[0.18em]",
  "[&_code]:rounded-[3px] [&_code]:bg-[color:var(--color-surface-2)] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:overflow-auto [&_pre]:rounded-[var(--radius-cap)] [&_pre]:bg-card [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:border-l [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:px-2",
].join(" ");

export function ContentMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn(MARKDOWN_CLASSES, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, htmlAsText, proseLineBreaks]} urlTransform={safeUrl} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
