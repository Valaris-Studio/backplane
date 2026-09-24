// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { pageErrorReport, type PageErrorReport } from "@/lib/page-error-report";
import { reloadPage } from "@/lib/reload-page";

function PageErrorFallback({ report }: { report: PageErrorReport }) {
  const { t } = useTranslation();
  return (
    <section role="alert" className="mx-auto w-full max-w-xl space-y-4 p-6 text-foreground">
      <h1 className="text-xl font-semibold">{t("pageRecovery.title")}</h1>
      <p>{t(report.kind === "module-load" ? "pageRecovery.moduleDescription" : "pageRecovery.description")}</p>
      <p className="text-sm text-muted-foreground">{t("pageRecovery.unsavedWarning")}</p>
      <Button type="button" onClick={reloadPage}>{t("pageRecovery.reload")}</Button>
      <details className="text-sm">
        <summary className="cursor-pointer">{t("pageRecovery.details")}</summary>
        <p className="my-2 text-muted-foreground">{t("pageRecovery.reportHelp")}</p>
        <textarea aria-label={t("pageRecovery.details")} readOnly value={JSON.stringify(report, null, 2)} rows={10} className="w-full rounded border border-border bg-background p-3 font-mono text-xs" onFocus={(event) => event.target.select()} />
      </details>
    </section>
  );
}

interface BoundaryProps { children: ReactNode; resetKey?: string }
interface BoundaryState { report: PageErrorReport | null; resetKey?: string }

export class PageErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { report: null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return props.resetKey !== state.resetKey ? { report: null, resetKey: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: unknown) {
    return { report: pageErrorReport(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Backplane page error", this.state.report);
    // Preserve the original exception and component stack for local debugging.
    console.error(error, info.componentStack);
  }

  render() {
    return this.state.report ? <PageErrorFallback report={this.state.report} /> : this.props.children;
  }
}

export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <PageErrorBoundary resetKey={location.pathname}>{children}</PageErrorBoundary>;
}
