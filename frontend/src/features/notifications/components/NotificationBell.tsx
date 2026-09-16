// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { gsap } from "gsap";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import {
  useNotificationLiveSync,
  useUnreadCount,
} from "../api/use-notifications";
import { NotificationInbox } from "./NotificationInbox";

interface NotificationBellProps {
  /** Current route's workspace slug; scopes the badge to that workspace. */
  slug?: string;
}

const MAX_BADGE = 99;

export function NotificationBell({ slug }: NotificationBellProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  // The bell shows the CURRENT workspace's unread (the badge follows the route).
  useNotificationLiveSync(slug);
  const { data: count = 0 } = useUnreadCount(slug);

  const badgeRef = useRef<HTMLSpanElement>(null);
  const pulseRef = useRef<HTMLSpanElement>(null);
  const prevCountRef = useRef(count);

  const display = count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
  const hasUnread = count > 0;

  // Spring the badge in when the count first becomes non-zero (back.out pop),
  // pulse a ring on every increase (an arrival), and drain it out on the way to
  // zero (mark-all-read). All motion is opacity/scale only — INVARIANT: GSAP
  // cannot tween a color-mix() value, so the glow ring animates scale+opacity
  // over a static box-shadow, never the shadow color itself.
  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = count;
    if (reducedMotion) return;

    const badge = badgeRef.current;
    const pulse = pulseRef.current;
    const tweens: (gsap.core.Tween | undefined)[] = [];

    const becameVisible = prev === 0 && count > 0;
    const increased = count > prev && prev > 0;

    if (badge && becameVisible) {
      tweens.push(
        gsap.fromTo(
          badge,
          { scale: 0.2, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.42, ease: "back.out(3)" },
        ),
      );
    }

    if (badge && increased) {
      // A small re-pop on the number so a fresh arrival registers.
      tweens.push(
        gsap.fromTo(
          badge,
          { scale: 0.8 },
          { scale: 1, duration: 0.34, ease: "back.out(2.4)" },
        ),
      );
    }

    if (pulse && (becameVisible || increased)) {
      tweens.push(
        gsap.fromTo(
          pulse,
          { opacity: 0.55, scale: 0.85 },
          { opacity: 0, scale: 1.9, duration: 0.7, ease: "power2.out" },
        ),
      );
    }

    if (badge && prev > 0 && count === 0) {
      tweens.push(
        gsap.fromTo(
          badge,
          { scale: 1, opacity: 1 },
          { scale: 0.2, opacity: 0, duration: 0.28, ease: "power2.in" },
        ),
      );
    }

    return () => {
      for (const tween of tweens) tween?.kill();
      const targets = [badge, pulse].filter(Boolean) as Element[];
      // gsap.set([], ...) warns "GSAP target not found" — guard the case where
      // neither ref ever mounted (badgeRef/pulseRef are gated behind hasUnread).
      if (targets.length) {
        gsap.set(targets, { clearProps: "transform,opacity" });
      }
    };
  }, [count, reducedMotion]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative shrink-0"
        onClick={() => setOpen(true)}
        aria-label={t("notifications.bellAria", { count })}
      >
        <Bell className="h-4 w-4" />
        {hasUnread ? (
          <>
            <span
              ref={pulseRef}
              aria-hidden
              className="pointer-events-none absolute right-1 top-1 h-4 w-4 rounded-full opacity-0 shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-primary)_55%,transparent)]"
            />
            <span
              ref={badgeRef}
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.62rem] font-bold leading-none text-primary-foreground shadow-soft"
            >
              {display}
            </span>
          </>
        ) : null}
      </Button>

      <NotificationInbox open={open} onOpenChange={setOpen} currentSlug={slug} />
    </>
  );
}
