// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link, useLocation, useNavigate, type LinkProps } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { useReturnNavigation } from "@/providers/ReturnNavigationProvider";

function plainClick(event: React.MouseEvent<HTMLAnchorElement>) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.currentTarget.target !== "_blank";
}

export function ContextLink({ onClick, id, state, ...props }: LinkProps) {
  const navigation = useReturnNavigation();
  const navigate = useNavigate();
  return <Link {...props} id={id} state={state} onClick={(event) => {
    onClick?.(event);
    if (!plainClick(event) || !navigation) return;
    const reference = navigation.capture(event.currentTarget);
    if (!reference) return;
    event.preventDefault();
    void navigate(props.to, { replace: props.replace, state: { ...state, bpReturn: reference }, preventScrollReset: props.preventScrollReset, relative: props.relative });
  }} />;
}

export function ReturnLink({ to, onClick, returnLabel, children, ...props }: LinkProps & { returnLabel?: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useReturnNavigation();
  const origin = navigation?.resolve(location.state?.bpReturn);
  const canReturn = !!origin?.canPop;
  return <><Link {...props} to={canReturn ? origin.href : to} onClick={(event) => {
    onClick?.(event);
    if (!plainClick(event) || !origin?.canPop) return;
    event.preventDefault();
    void navigate(-1);
  }}>{canReturn && returnLabel ? returnLabel : children}</Link>
    {location.state?.bpReturn && !canReturn ? <p role="status" className="text-xs text-muted-foreground">{t("navigation.previousViewUnavailable")}</p> : null}
  </>;
}
