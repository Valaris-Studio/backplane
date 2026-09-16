// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Bell,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Clock3,
  FileText,
  Gauge,
  Globe2,
  Kanban,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  StickyNote,
  Sun,
  Users,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  [LayoutDashboard, "Panel", true],
  [Kanban, "Tableros", false],
  [StickyNote, "Notas", false],
  [FileText, "Recursos", false],
  [MessageSquare, "Canales", false],
  [Users, "Miembros", false],
  [ClipboardCheck, "Aprobaciones", false],
  [Bot, "Runners", false],
  [Clock3, "Historial", false],
  [BookOpen, "Documentación", false],
] as const;

interface DashboardContextProps {
  children: ReactNode;
  variantName: string;
  hypothesis: string;
}

export function DashboardContext({
  children,
  variantName,
  hypothesis,
}: DashboardContextProps) {
  const [dark, setDark] = useState(
    () => new URLSearchParams(window.location.search).get("theme") === "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    const url = new URL(window.location.href);
    if (dark) url.searchParams.set("theme", "dark");
    else url.searchParams.delete("theme");
    window.history.replaceState(null, "", url);
  }, [dark]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen md:grid-cols-[13.5rem_minmax(0,1fr)]">
        <aside className="hidden border-r border-white/8 bg-[oklch(0.22_0.045_150)] text-white md:flex md:flex-col">
          <div className="flex h-14 items-center gap-2.5 border-b border-white/8 px-4">
            <div className="grid h-7 w-7 place-items-center rounded-[var(--radius-cap)] bg-[oklch(0.78_0.2_135)] text-[oklch(0.18_0.04_150)] shadow-[0_0_20px_oklch(0.78_0.2_135/0.25)]">
              <CircleDot className="h-4 w-4" strokeWidth={2.4} />
            </div>
            <span className="font-heading text-base font-bold tracking-[-0.04em]">
              Backplane
            </span>
          </div>
          <div className="border-b border-white/8 px-4 py-3">
            <p className="text-[0.62rem] font-semibold uppercase tracking-[0.2em] text-white/42">
              Espacio
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-white/90">
              internal-projects
            </p>
          </div>
          <nav className="flex-1 space-y-0.5 p-2.5" aria-label="Navegación simulada">
            {NAV_ITEMS.map(([Icon, label, active]) => (
              <div
                key={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-left text-xs font-medium",
                  active
                    ? "bg-white/9 text-[oklch(0.82_0.18_135)]"
                    : "text-white/62",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </div>
            ))}
          </nav>
          <div className="border-t border-white/8 p-3 text-[0.68rem] text-white/42">
            Laboratorio visual aislado
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border/70 bg-background/88 px-3 backdrop-blur-xl sm:px-5">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon" }),
                  "pointer-events-none md:hidden",
                )}
                aria-hidden="true"
              >
                <Menu />
              </span>
              <span className="hidden sm:inline">Espacios de trabajo</span>
              <span className="hidden text-border sm:inline">/</span>
              <span className="truncate font-medium text-foreground">Internal Projects</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="hidden items-center gap-1.5 rounded-full border border-border/70 bg-card/80 px-2.5 py-1 text-[0.68rem] font-semibold sm:flex">
                <CircleDot className="h-3 w-3 text-primary" /> Observador
              </span>
              <span
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon" }),
                  "pointer-events-none",
                )}
                aria-hidden="true"
              >
                <Bell />
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={dark ? "Usar tema claro" : "Usar tema oscuro"}
                onClick={() => setDark((current) => !current)}
              >
                {dark ? <Sun /> : <Moon />}
              </Button>
              <span
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "pointer-events-none hidden sm:flex",
                )}
                aria-hidden="true"
              >
                <Globe2 /> ES <ChevronDown className="h-3 w-3" />
              </span>
              <div className="grid h-8 w-8 place-items-center rounded-full bg-muted text-xs font-bold">M</div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-[96rem] space-y-4 px-3 pb-28 pt-4 sm:px-5 md:pb-24">
            <section className="rounded-[var(--radius-lg)] border border-border/70 bg-[color:var(--color-surface-1)] p-4 shadow-panel sm:flex sm:items-end sm:justify-between sm:gap-6">
              <div>
                <p className="text-[0.64rem] font-semibold uppercase tracking-[0.22em] text-primary">Panel</p>
                <h1 className="mt-1 text-xl font-bold">Bienvenido a internal-projects</h1>
                <p className="mt-1 text-xs text-muted-foreground">Resumen rápido de tu espacio de trabajo</p>
              </div>
              <div className="mt-3 flex gap-2 sm:mt-0">
                <span
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "pointer-events-none",
                  )}
                  aria-hidden="true"
                >
                  <Plus /> Nueva nota
                </span>
                <span
                  className={cn(
                    buttonVariants({ size: "sm" }),
                    "pointer-events-none",
                  )}
                  aria-hidden="true"
                >
                  <Plus /> Nuevo tablero
                </span>
              </div>
            </section>

            <section aria-label={`Variante ${variantName}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-0.5">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Experimento · {variantName}
                </p>
                <p className="max-w-2xl text-right text-[0.68rem] text-muted-foreground">{hypothesis}</p>
              </div>
              {children}
            </section>

            <section className="grid gap-3 sm:grid-cols-3" aria-hidden="true">
              {[
                [Kanban, "Tableros", "1 activo"],
                [CheckCircle2, "Tarjetas", "8 completadas"],
                [Gauge, "Actividad reciente", "Hace 12 min"],
              ].map(([Icon, label, value]) => {
                const StatIcon = Icon as typeof Kanban;
                return (
                  <div key={String(label)} className="min-h-24 rounded-[var(--radius-lg)] border border-border/60 bg-card/65 p-4 opacity-60 shadow-soft">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground"><StatIcon className="h-4 w-4" />{String(label)}</div>
                    <p className="mt-4 text-lg font-semibold">{String(value)}</p>
                  </div>
                );
              })}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
