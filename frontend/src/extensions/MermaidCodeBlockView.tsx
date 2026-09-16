// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { useTheme } from "@/hooks/use-theme";
import { renderMermaid } from "@/lib/mermaid-render";
import { cn } from "@/lib/utils";

// Typing a diagram re-renders on every keystroke otherwise; mermaid parses the
// whole source each time, so an unthrottled render makes editing feel molasses.
const RENDER_DEBOUNCE_MS = 300;

type RenderState =
  | { status: "idle" }
  | { status: "rendering" }
  | { status: "ready"; svg: string }
  | { status: "error"; message: string };

export function MermaidCodeBlockView({ node, editor }: NodeViewProps) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const reactId = useId();
  const [isEditing, setIsEditing] = useState(false);
  const [state, setState] = useState<RenderState>({ status: "idle" });
  const wrapperRef = useRef<HTMLDivElement>(null);

  const language = node.attrs.language as string | null;
  const isMermaid = language === "mermaid";
  const source = node.textContent;
  const editable = editor.isEditable;

  useEffect(() => {
    if (!isMermaid) return;
    if (!source.trim()) {
      setState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setState({ status: "rendering" });
    const timer = setTimeout(() => {
      renderMermaid({ id: reactId, source, theme: resolvedTheme })
        .then((svg) => {
          if (!cancelled) setState({ status: "ready", svg });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isMermaid, source, resolvedTheme, reactId]);

  const stopEditing = useCallback(() => setIsEditing(false), []);

  useEffect(() => {
    if (!isEditing) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") stopEditing();
    }
    // Blur alone is unreliable inside ProseMirror (selection churn fires it);
    // an outside-pointer check is what actually distinguishes "left the node".
    function onPointerDown(event: PointerEvent) {
      if (!wrapperRef.current?.contains(event.target as globalThis.Node)) stopEditing();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isEditing, stopEditing]);

  // Every non-mermaid language keeps the stock code-block rendering. The
  // <pre><code> shape is load-bearing: index.css styles `.tiptap-editor pre`
  // and its nested code, so anything else silently restyles every code block
  // in the product.
  if (!isMermaid) {
    return (
      <NodeViewWrapper>
        <pre>
          <NodeViewContent<"code"> as="code" />
        </pre>
      </NodeViewWrapper>
    );
  }

  function startEditing() {
    setIsEditing(true);
    editor.chain().focus().run();
  }

  const showSource = editable && isEditing;

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className="group relative my-2"
      data-mermaid-block=""
    >
      {/* NodeViewContent is ALWAYS mounted, only visually hidden while the
          preview is showing. Unmounting it would detach ProseMirror's managed
          DOM for this node and lose the diagram text. */}
      <pre
        data-mermaid-source=""
        className={cn(showSource ? "block" : "sr-only")}
        aria-hidden={showSource ? undefined : true}
      >
        <NodeViewContent<"code"> as="code" />
      </pre>

      {!showSource && (
        <div
          data-mermaid-preview=""
          className="overflow-x-auto rounded-sm border border-border/60 bg-muted/40 p-3"
        >
          {state.status === "ready" && (
            // mermaid renders with securityLevel "strict", which runs its own
            // DOMPurify pass over this markup and disables click bindings.
            <div
              className="flex justify-center [&_svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          )}
          {state.status === "rendering" && (
            <p className="text-xs text-muted-foreground">{t("editor.mermaidLoading")}</p>
          )}
          {state.status === "error" && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-destructive">{t("editor.mermaidError")}</p>
              <p className="text-xs text-muted-foreground">{state.message}</p>
              {/* The unrenderable source is shown verbatim so a typo is
                  fixable in place — a failed render must never hide the text. */}
              <pre className="overflow-x-auto text-xs text-muted-foreground">
                <code>{source}</code>
              </pre>
            </div>
          )}
          {state.status === "idle" && (
            <p className="text-xs text-muted-foreground">{t("editor.mermaid")}</p>
          )}
        </div>
      )}

      {editable && !showSource && (
        <button
          type="button"
          onClick={startEditing}
          aria-label={t("editor.mermaidEdit")}
          title={t("editor.mermaidEdit")}
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-background opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </NodeViewWrapper>
  );
}
