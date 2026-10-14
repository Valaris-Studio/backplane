// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, type Location } from "react-router-dom";
import { CheckCircle2, Clock, ShieldAlert, XCircle } from "lucide-react";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isApiError } from "@/lib/api-error";
import { formatDateTime, formatTime } from "@/lib/format";
import { useAuthModes } from "@/features/auth/api/use-auth-modes";
import {
  forgetReturnedFromSignIn,
  redirectToLogin,
  returnedFromSignInTo,
} from "@/features/auth/redirect-to-login";
import {
  useCompanionPairing,
  useDecidePairing,
  type PairingRequest,
} from "../api/use-companion-pairing";
import { normalizeUserCode } from "../user-code";
import {
  carryPairingCode,
  forgetCarriedPairingCode,
  readCarriedPairingCode,
} from "../pairing-code-carry";

type View =
  | "companionOff"
  | "enterCode"
  | "loading"
  | "signIn"
  | "invalid"
  | "rateLimited"
  | "unavailable"
  | "pending"
  | "approved"
  | "denied"
  | "expired";

const SESSION_ERROR_CODES = new Set([
  "authentication_required",
  "session_invalid",
  "session_user_not_found",
]);

function failureView(error: unknown): View {
  if (!isApiError(error)) return "unavailable";
  if (error.status === 401 || (error.status === 403 && SESSION_ERROR_CODES.has(error.errorCode ?? ""))) {
    return "signIn";
  }
  if (error.status === 404) return "invalid";
  if (error.status === 429) return "rateLimited";
  if (error.errorCode === "pairing_expired") return "expired";
  if (error.errorCode === "pairing_denied") return "denied";
  if (error.errorCode === "pairing_consumed" || error.errorCode === "pairing_approved") {
    return "approved";
  }
  return "unavailable";
}

function stateView(request: PairingRequest): View {
  switch (request.state) {
    case "pending":
      return "pending";
    case "approved":
    case "consumed":
      return "approved";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
  }
}

// `#code=` (current links: a fragment never reaches a server) or the legacy
// `?code=`.
function codeFromLink(location: Location): string | null {
  return (
    new URLSearchParams(location.hash.replace(/^#/, "")).get("code") ??
    new URLSearchParams(location.search).get("code")
  );
}

const FINISHED_VIEWS: ReadonlySet<View> = new Set([
  "companionOff",
  "approved",
  "denied",
  "expired",
  "invalid",
]);

export function CompanionPairPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  // A bare visit refills a carried code only when sign-in just returned here:
  // a later visit in the same tab starts clean.
  const [linkedCode] = useState(
    () =>
      codeFromLink(location) ??
      (returnedFromSignInTo(location.pathname) ? readCarriedPairingCode() : null) ??
      "",
  );
  const [userCode, setUserCode] = useState(() => normalizeUserCode(linkedCode));
  const [typedCode, setTypedCode] = useState(userCode ?? linkedCode);
  const [typedMalformed, setTypedMalformed] = useState(false);

  // Read in render, which may run twice (StrictMode); forgotten once mounted.
  useEffect(() => forgetReturnedFromSignIn(), []);

  // The code leaves the address bar before anything else happens, so it is
  // not kept in history, bookmarks or a later sign-in return path.
  useEffect(() => {
    if (codeFromLink(location) === null) return;
    const search = new URLSearchParams(location.search);
    search.delete("code");
    const rest = search.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : "", hash: "" }, { replace: true });
  }, [location, navigate]);
  // Unreadable modes fall through to the lookup, which the server answers.
  const modes = useAuthModes();
  const companionOff = modes.data?.companion_enabled === false;
  const lookup = useCompanionPairing(modes.isPending || companionOff ? null : userCode);
  const approve = useDecidePairing(userCode ?? "", "approve");
  const deny = useDecidePairing(userCode ?? "", "deny");
  const decisionError = approve.error ?? deny.error;

  let view: View;
  if (companionOff) view = "companionOff";
  else if (userCode === null) view = typedMalformed ? "invalid" : "enterCode";
  else if (lookup.isPending) view = "loading";
  else if (lookup.isError) view = failureView(lookup.error);
  else if (decisionError && failureView(decisionError) !== "unavailable") view = failureView(decisionError);
  else view = stateView(lookup.data);

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    const code = normalizeUserCode(typedCode);
    setTypedMalformed(code === null);
    if (code === null) return;
    approve.reset();
    deny.reset();
    setTypedCode(code);
    setUserCode(code);
  };

  // Sign-in is a full-page round trip; the code waits in this tab, not in a URL.
  useEffect(() => {
    if (userCode === null) return;
    if (FINISHED_VIEWS.has(view)) forgetCarriedPairingCode();
    else carryPairingCode(userCode);
  }, [userCode, view]);

  const deciding = approve.isPending || deny.isPending;
  const showsCodeForm =
    view !== "companionOff" && view !== "approved" && view !== "denied" && view !== "signIn";

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <BrandLogo className="mx-auto h-8 w-auto" />
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-bold tracking-tight">{t("companionPairing.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("companionPairing.subtitle")}</p>
        </div>

        {showsCodeForm && (
          <form onSubmit={submitCode} noValidate className="space-y-1.5">
            <label htmlFor="companion-pairing-code" className="text-sm font-medium">
              {t("companionPairing.codeLabel")}
            </label>
            <div className="flex gap-2">
              <Input
                id="companion-pairing-code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="font-mono tracking-widest"
                value={typedCode}
                onChange={(event) => setTypedCode(event.target.value)}
              />
              <Button type="submit" variant="outline">
                {t("companionPairing.continue")}
              </Button>
            </div>
          </form>
        )}

        {view === "loading" && (
          <p role="status" className="text-center text-sm text-muted-foreground">
            {t("companionPairing.loading")}
          </p>
        )}

        {view === "pending" && lookup.data && (
          <section className="space-y-4 rounded-lg border bg-card p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("companionPairing.device")}</dt>
              <dd className="font-medium break-words">
                {lookup.data.name ?? t("companionPairing.unnamedDevice")}
              </dd>
              <dt className="text-muted-foreground">{t("companionPairing.platform")}</dt>
              <dd className="font-mono">{`${lookup.data.platform}/${lookup.data.arch}`}</dd>
              <dt className="text-muted-foreground">{t("companionPairing.requested")}</dt>
              <dd>{formatDateTime(lookup.data.requested_at)}</dd>
              <dt className="text-muted-foreground">{t("companionPairing.expires")}</dt>
              <dd>{formatTime(lookup.data.expires_at)}</dd>
            </dl>
            <p className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
              <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>{t("companionPairing.warning")}</span>
            </p>
            {decisionError && (
              <p role="alert" className="text-sm text-destructive">
                {t("companionPairing.unavailable")}
              </p>
            )}
            <div className="flex gap-2">
              <Button className="flex-1" disabled={deciding} onClick={() => approve.mutate()}>
                {t("companionPairing.approve")}
              </Button>
              <Button
                className="flex-1"
                variant="outline"
                disabled={deciding}
                onClick={() => deny.mutate()}
              >
                {t("companionPairing.deny")}
              </Button>
            </div>
          </section>
        )}

        {view === "companionOff" && (
          <Outcome icon={<XCircle className="h-6 w-6 text-muted-foreground" />} titleKey="companionOff" />
        )}
        {view === "approved" && (
          <Outcome icon={<CheckCircle2 className="h-6 w-6 text-emerald-600" />} titleKey="approved" />
        )}
        {view === "denied" && (
          <Outcome icon={<XCircle className="h-6 w-6 text-muted-foreground" />} titleKey="denied" />
        )}
        {view === "expired" && (
          <Outcome icon={<Clock className="h-6 w-6 text-muted-foreground" />} titleKey="expired" />
        )}
        {view === "invalid" && (
          <Outcome icon={<XCircle className="h-6 w-6 text-destructive" />} titleKey="invalid" />
        )}
        {view === "rateLimited" && (
          <p role="alert" className="text-center text-sm text-destructive">
            {t("companionPairing.rateLimited")}
          </p>
        )}
        {view === "unavailable" && (
          <p role="alert" className="text-center text-sm text-destructive">
            {t("companionPairing.unavailable")}
          </p>
        )}
        {view === "signIn" && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted-foreground">{t("companionPairing.signInBody")}</p>
            <Button onClick={() => redirectToLogin()}>{t("companionPairing.signIn")}</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Outcome({
  icon,
  titleKey,
}: {
  icon: React.ReactNode;
  titleKey: "companionOff" | "approved" | "denied" | "expired" | "invalid";
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col items-center gap-2 rounded-lg border bg-card p-6 text-center">
      {icon}
      <h2 className="text-base font-semibold">{t(`companionPairing.outcome.${titleKey}.title`)}</h2>
      <p className="text-sm text-muted-foreground">{t(`companionPairing.outcome.${titleKey}.body`)}</p>
    </section>
  );
}
