// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Info, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

export type RichTooltipLink = { label: string; href: string };
export type RichTooltipRow = { label: string; value: string };
export type RichTooltipCalloutVariant = "info" | "warn" | "success" | "note";
export type RichTooltipCallout = {
  variant?: RichTooltipCalloutVariant;
  text: string;
};

// A section mirrors the panel content one level deep (no recursion) so authors
// can group related rows/callouts/code under a sub-heading without the schema
// becoming infinitely nestable.
export type RichTooltipSection = {
  title: string;
  summary?: string;
  examples?: string[];
  rows?: RichTooltipRow[];
  callouts?: RichTooltipCallout[];
  code?: string;
  links?: RichTooltipLink[];
};

export type RichTooltipPanel = {
  examples?: string[];
  rows?: RichTooltipRow[];
  callouts?: RichTooltipCallout[];
  code?: string;
  links?: RichTooltipLink[];
  sections?: RichTooltipSection[];
};

type Side = "top" | "bottom" | "left" | "right";

type RichTooltipProps = {
  summary?: string;
  panel?: RichTooltipPanel;
  // Escape hatch for callsites that need a custom layout the declarative
  // schema can't express (e.g. an interactive diagram). When supplied, it
  // renders in place of the declarative panel. `summary` still shows as the
  // popover heading so keyboard/screen-reader users aren't stranded.
  customPanel?: React.ReactNode;
  i18nKey?: string;
  children: React.ReactNode;
  side?: Side;
  className?: string;
};

type TooltipContent = {
  summary: string;
  examples?: string[];
  rows?: RichTooltipRow[];
  callouts?: RichTooltipCallout[];
  code?: string;
  links?: RichTooltipLink[];
  sections?: RichTooltipSection[];
};

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((item) => typeof item === "string")
    ? (v as string[])
    : undefined;
}

function asRows(v: unknown): RichTooltipRow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RichTooltipRow[] = [];
  for (const item of v) {
    if (
      item && typeof item === "object"
      && typeof (item as RichTooltipRow).label === "string"
      && typeof (item as RichTooltipRow).value === "string"
    ) {
      out.push(item as RichTooltipRow);
    }
  }
  return out.length ? out : undefined;
}

function asCallouts(v: unknown): RichTooltipCallout[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RichTooltipCallout[] = [];
  for (const item of v) {
    if (item && typeof item === "object" && typeof (item as RichTooltipCallout).text === "string") {
      out.push(item as RichTooltipCallout);
    }
  }
  return out.length ? out : undefined;
}

function asLinks(v: unknown): RichTooltipLink[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RichTooltipLink[] = [];
  for (const item of v) {
    if (
      item && typeof item === "object"
      && typeof (item as RichTooltipLink).href === "string"
      && typeof (item as RichTooltipLink).label === "string"
    ) {
      out.push(item as RichTooltipLink);
    }
  }
  return out.length ? out : undefined;
}

function asSections(v: unknown): RichTooltipSection[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: RichTooltipSection[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Partial<RichTooltipSection>;
    if (typeof obj.title !== "string") continue;
    out.push({
      title: obj.title,
      summary: typeof obj.summary === "string" ? obj.summary : undefined,
      examples: asStringArray(obj.examples),
      rows: asRows(obj.rows),
      callouts: asCallouts(obj.callouts),
      code: typeof obj.code === "string" ? obj.code : undefined,
      links: asLinks(obj.links),
    });
  }
  return out.length ? out : undefined;
}

const EMPTY_CONTENT: TooltipContent = { summary: "" };

// `t(..., {returnObjects:true})` plus the full asRows/asLinks/asCallouts/
// asSections revalidation costs ~16x a plain lookup, and cards mount 1-3
// tooltips each — so it must not run per render. Content is static per
// language: no callsite passes interpolation params through this hook (the one
// tooltip that interpolates, kanban.runnerBadge.touched, passes an explicit
// `summary` prop that overrides this result), so a process-wide cache keyed by
// language is safe. Misses are NOT cached: i18next may still be loading
// resources, and pinning the fallback would strand the tooltip empty.
const contentCache = new Map<string, TooltipContent>();

/**
 * Reads tooltip content from `ui.tooltips.<key>` via react-i18next.
 * Returns an empty-summary fallback when the key is missing so callers can
 * still render a safe trigger without guarding every access.
 */
export function useTooltipContent(i18nKey?: string): TooltipContent {
  const { t, i18n } = useTranslation();
  const language = i18n.language;

  return React.useMemo(() => {
    if (!i18nKey) return EMPTY_CONTENT;

    const cacheKey = `${language}:${i18nKey}`;
    const cached = contentCache.get(cacheKey);
    if (cached) return cached;

    const fullKey = `ui.tooltips.${i18nKey}`;
    const raw = t(fullKey, { returnObjects: true }) as unknown;
    if (typeof raw === "string" || raw == null) {
      const content: TooltipContent = {
        summary: typeof raw === "string" ? raw : "",
      };
      if (i18n.exists(fullKey)) contentCache.set(cacheKey, content);
      return content;
    }
    const obj = raw as Record<string, unknown>;
    const content: TooltipContent = {
      summary: typeof obj.summary === "string" ? obj.summary : "",
      examples: asStringArray(obj.examples),
      rows: asRows(obj.rows),
      callouts: asCallouts(obj.callouts),
      code: typeof obj.code === "string" ? obj.code : undefined,
      links: asLinks(obj.links),
      sections: asSections(obj.sections),
    };
    contentCache.set(cacheKey, content);
    return content;
  }, [i18nKey, language, t, i18n]);
}

// Translate classes match the chosen side: the popover's anchor point is
// positioned at the trigger edge via `top/left` style, then the popover is
// shifted so it sits on the correct side of the trigger. E.g., `side="top"`
// sets top/left to the trigger's top-center; translating -100%/-50% + a
// small gap places the popover above the trigger and horizontally centered.
const SIDE_TRANSFORMS: Record<Side, string> = {
  top: "-translate-x-1/2 -translate-y-full -mt-2",
  bottom: "-translate-x-1/2 mt-2",
  left: "-translate-x-full -translate-y-1/2 -ml-2",
  right: "-translate-y-1/2 ml-2",
};

type FixedPosition = { top: number; left: number };

// Anchor point on the trigger for each side. Popover is then translated
// relative to this anchor via SIDE_TRANSFORMS.
function anchorFor(rect: DOMRect, side: Side): FixedPosition {
  switch (side) {
    case "top":
      return { top: rect.top, left: rect.left + rect.width / 2 };
    case "bottom":
      return { top: rect.bottom, left: rect.left + rect.width / 2 };
    case "left":
      return { top: rect.top + rect.height / 2, left: rect.left };
    case "right":
      return { top: rect.top + rect.height / 2, left: rect.right };
  }
}

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

// Workspace-relative hrefs authored in i18n (no leading slash, not a full URL)
// are resolved against the active workspace slug so tooltip links don't
// accidentally stack onto the current route. Absolute paths and external URLs
// pass through.
function resolveHref(href: string, slug: string | undefined): string {
  if (isExternalHref(href)) return href;
  if (href.startsWith("/")) return href;
  if (!slug) return `/${href}`;
  return `/${slug}/${href}`;
}

// The trigger often wraps a live control (e.g. an "Add card" <button>). When
// an event originates inside such a child, the child owns the interaction:
// the tooltip must not toggle its panel over whatever the child triggered,
// and the click-driven focus must not pop the hover tip over an opening
// dialog. closest() stops at the trigger span itself (it has role="button"),
// so a hit means a *nested* interactive element, never the plain-content case.
function interactiveChildOwnsEvent(event: React.SyntheticEvent<HTMLSpanElement>): boolean {
  const target = event.target as HTMLElement | null;
  if (!target || target === event.currentTarget) return false;
  const interactive = target.closest(
    "button, a[href], input, select, textarea, [role='button']",
  );
  return interactive !== null && interactive !== event.currentTarget;
}

function panelHasContent(panel: RichTooltipPanel | undefined, customPanel: React.ReactNode | undefined): boolean {
  if (customPanel) return true;
  if (!panel) return false;
  return Boolean(
    panel.examples?.length
    || panel.rows?.length
    || panel.callouts?.length
    || panel.code
    || panel.links?.length
    || panel.sections?.length,
  );
}

export function RichTooltip({
  summary,
  panel,
  customPanel,
  i18nKey,
  children,
  side = "top",
  className,
}: RichTooltipProps) {
  const fromI18n = useTooltipContent(i18nKey);
  const { t } = useTranslation();
  const resolvedSummary = summary ?? fromI18n.summary;
  const resolvedPanel: RichTooltipPanel | undefined = panel ?? (
    fromI18n.examples || fromI18n.links || fromI18n.rows || fromI18n.callouts
      || fromI18n.code || fromI18n.sections
      ? {
          examples: fromI18n.examples,
          rows: fromI18n.rows,
          callouts: fromI18n.callouts,
          code: fromI18n.code,
          links: fromI18n.links,
          sections: fromI18n.sections,
        }
      : undefined
  );
  const hasPanel = panelHasContent(resolvedPanel, customPanel);

  const popupId = React.useId();
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const { slug } = useParams<{ slug: string }>();

  const [hoverOpen, setHoverOpen] = React.useState(false);
  const [expandedOpen, setExpandedOpen] = React.useState(false);
  const [position, setPosition] = React.useState<FixedPosition | null>(null);

  const hoverTooltipOpen = hoverOpen && !expandedOpen && Boolean(resolvedSummary);

  // Anchor the small hover tooltip to the trigger. The expanded modal centers
  // itself via CSS flex and does not need an anchor position.
  React.useLayoutEffect(() => {
    if (!hoverTooltipOpen) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(anchorFor(rect, side));
  }, [hoverTooltipOpen, side]);


  React.useEffect(() => {
    if (!expandedOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setExpandedOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expandedOpen]);

  React.useEffect(() => {
    if (!expandedOpen) return;
    function handlePointer(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setExpandedOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
    };
  }, [expandedOpen]);

  function handleTriggerClick(event: React.MouseEvent<HTMLSpanElement>) {
    if (interactiveChildOwnsEvent(event)) {
      // The child's click likely opened something (dialog, menu) — make sure
      // the hover tooltip never lingers over it.
      setHoverOpen(false);
      return;
    }
    if (!hasPanel) return;
    setExpandedOpen((prev) => !prev);
    setHoverOpen(false);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLSpanElement>) {
    if (interactiveChildOwnsEvent(event)) return;
    if (!hasPanel) return;
    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      setExpandedOpen((prev) => !prev);
      setHoverOpen(false);
    }
  }

  // True for a short window after any pointer press inside the trigger — the
  // signal that a following focus event is click-driven, not keyboard Tab.
  const pointerInteractionRef = React.useRef(false);
  function markPointerInteraction() {
    pointerInteractionRef.current = true;
    window.setTimeout(() => {
      pointerInteractionRef.current = false;
    }, 200);
  }

  function handleTriggerFocus(event: React.FocusEvent<HTMLSpanElement>) {
    // CLICK-driven focus on a wrapped control must not pop the tooltip (the
    // click likely opened a dialog the tip would fight) — but keyboard Tab
    // focus must still show it, or keyboard users lose the help mouse users
    // get on hover (WCAG 1.4.13).
    if (interactiveChildOwnsEvent(event) && pointerInteractionRef.current) return;
    setHoverOpen(true);
  }

  const showTooltip = hoverOpen && !expandedOpen && Boolean(resolvedSummary);
  const canPortal = typeof document !== "undefined";
  const popoverStyle = position
    ? { position: "fixed" as const, top: position.top, left: position.left }
    : { display: "none" as const };

  const tooltipNode = showTooltip && canPortal ? (
    <div
      id={popupId}
      role="tooltip"
      style={popoverStyle}
      className={cn(
        "z-[60] w-max max-w-xs overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-popover/96 px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-soft backdrop-blur-xl",
        SIDE_TRANSFORMS[side],
      )}
    >
      <div>{resolvedSummary}</div>
      {hasPanel ? (
        <div className="mt-1 text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          {t("ui.tooltips.clickForDetails")}
        </div>
      ) : null}
    </div>
  ) : null;

  // Expanded view is a centered modal, not an anchored popover. Rich-content
  // panels were too big to fit inside a tooltip cone; centering avoids
  // viewport-edge clipping entirely and lets the user read without the
  // surrounding UI fighting for attention. The backdrop blurs + dims to
  // make the focus shift obvious.
  const popoverNode = hasPanel && expandedOpen && canPortal ? (
    <div
      data-testid="rt-backdrop"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
    >
      <div
        id={popupId}
        ref={popoverRef}
        role="dialog"
        aria-modal="true"
        aria-label={resolvedSummary || undefined}
        className={cn(
          "w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-[var(--radius-md)] border border-border/75 bg-popover/98 p-5 text-sm text-popover-foreground shadow-panel",
        )}
      >
        {resolvedSummary ? (
          <h3 className="text-base font-semibold leading-tight tracking-[-0.01em]">
            {resolvedSummary}
          </h3>
        ) : null}

        {customPanel ? (
          <div className="mt-3">{customPanel}</div>
        ) : resolvedPanel ? (
          <PanelBody panel={resolvedPanel} slug={slug} />
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div className={cn("relative inline-flex", className)}>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-describedby={popupId}
        aria-expanded={hasPanel ? expandedOpen : undefined}
        aria-haspopup={hasPanel ? "dialog" : undefined}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        onPointerDownCapture={markPointerInteraction}
        onMouseDownCapture={markPointerInteraction}
        onMouseEnter={() => setHoverOpen(true)}
        onMouseLeave={() => setHoverOpen(false)}
        onFocus={handleTriggerFocus}
        onBlur={() => setHoverOpen(false)}
        className="inline-flex cursor-default items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {children}
      </span>

      {tooltipNode ? createPortal(tooltipNode, document.body) : null}
      {popoverNode ? createPortal(popoverNode, document.body) : null}
    </div>
  );
}

function PanelBody({ panel, slug }: { panel: RichTooltipPanel; slug: string | undefined }) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {panel.rows?.length ? <RowsBlock rows={panel.rows} /> : null}
      {panel.callouts?.length ? <CalloutsBlock callouts={panel.callouts} /> : null}
      {panel.code ? <CodeBlock code={panel.code} /> : null}
      {panel.examples?.length ? <ExamplesBlock examples={panel.examples} /> : null}
      {panel.sections?.length ? <SectionsBlock sections={panel.sections} slug={slug} /> : null}
      {panel.links?.length ? <LinksBlock links={panel.links} slug={slug} /> : null}
    </div>
  );
}

function ExamplesBlock({ examples }: { examples: string[] }) {
  return (
    <ul
      data-testid="rt-examples"
      className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground"
    >
      {examples.map((example, index) => (
        <li
          key={`${index}-${example}`}
          className="pl-3 -indent-3 before:content-['—'] before:pr-2 before:text-border"
        >
          {example}
        </li>
      ))}
    </ul>
  );
}

function RowsBlock({ rows }: { rows: RichTooltipRow[] }) {
  return (
    <table
      data-testid="rt-rows"
      className="w-full border-collapse text-xs"
    >
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={`${index}-${row.label}`}
            className="border-b border-border/40 last:border-b-0"
          >
            <th
              scope="row"
              className="py-1 pr-3 text-left align-top font-medium text-muted-foreground"
            >
              {row.label}
            </th>
            <td className="py-1 align-top font-mono text-[0.72rem] text-foreground">
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CALLOUT_STYLES: Record<RichTooltipCalloutVariant, { border: string; tint: string; icon: React.ComponentType<{ className?: string }> }> = {
  info: {
    border: "border-l-info",
    tint: "bg-info/10 text-[color:var(--color-info-foreground)]",
    icon: Info,
  },
  warn: {
    border: "border-l-warning",
    tint: "bg-warning/12 text-[color:var(--color-warning-foreground)]",
    icon: AlertTriangle,
  },
  success: {
    border: "border-l-success",
    tint: "bg-success/12 text-[color:var(--color-success-foreground)]",
    icon: CheckCircle2,
  },
  note: {
    border: "border-l-border",
    tint: "bg-muted/40 text-foreground",
    icon: Lightbulb,
  },
};

function CalloutsBlock({ callouts }: { callouts: RichTooltipCallout[] }) {
  return (
    <ul data-testid="rt-callouts" className="flex flex-col gap-1.5">
      {callouts.map((callout, index) => {
        const variant = callout.variant ?? "note";
        const { border, tint, icon: Icon } = CALLOUT_STYLES[variant];
        return (
          <li
            key={`${index}-${callout.text}`}
            data-variant={variant}
            className={cn(
              "flex items-start gap-2 rounded-[var(--radius-sm)] border-l-2 px-2 py-1.5 text-xs leading-snug",
              border,
              tint,
            )}
          >
            <Icon className="mt-[2px] h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{callout.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre
      data-testid="rt-code"
      className="overflow-x-auto rounded-[var(--radius-sm)] border border-border/50 bg-muted/40 p-2 text-[0.7rem] leading-relaxed"
    >
      <code className="font-mono">{code}</code>
    </pre>
  );
}

function LinksBlock({ links, slug }: { links: RichTooltipLink[]; slug: string | undefined }) {
  return (
    <div
      data-testid="rt-links"
      className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium"
    >
      {links.map((link) => {
        const external = isExternalHref(link.href);
        const href = resolveHref(link.href, slug);
        return (
          <a
            key={link.href}
            href={href}
            className="text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
            {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            {link.label}
          </a>
        );
      })}
    </div>
  );
}

function SectionsBlock({ sections, slug }: { sections: RichTooltipSection[]; slug: string | undefined }) {
  return (
    <div data-testid="rt-sections" className="flex flex-col gap-3">
      {sections.map((section, index) => (
        <section
          key={`${index}-${section.title}`}
          className="rounded-[var(--radius-sm)] border border-border/50 bg-surface-1/40 px-3 py-2"
        >
          <h4 className="text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {section.title}
          </h4>
          {section.summary ? (
            <p className="mt-1 text-xs leading-snug text-foreground">{section.summary}</p>
          ) : null}
          <div className="mt-2 flex flex-col gap-2">
            {section.rows?.length ? <RowsBlock rows={section.rows} /> : null}
            {section.callouts?.length ? <CalloutsBlock callouts={section.callouts} /> : null}
            {section.code ? <CodeBlock code={section.code} /> : null}
            {section.examples?.length ? <ExamplesBlock examples={section.examples} /> : null}
            {section.links?.length ? <LinksBlock links={section.links} slug={slug} /> : null}
          </div>
        </section>
      ))}
    </div>
  );
}
