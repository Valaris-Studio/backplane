// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { markReturnedFromSignIn, takeReturnPath } from "../redirect-to-login";

// The OIDC callback lands on `/#signed_in` once a sign-in completed.
const SIGNED_IN_FRAGMENT = "#signed_in";

// Single sign-on's callback always lands on the home page; this carries on to
// the page that sent the person to sign in (e.g. a companion pairing link).
// Only a completed sign-in marks that page as a return from sign-in: a fresh
// return key alone proves nothing.
export function ResumeAfterSignIn() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (pathname !== "/") return;
    const signedIn = hash === SIGNED_IN_FRAGMENT;
    const returnPath = takeReturnPath();
    if (returnPath && returnPath !== "/") {
      if (signedIn) markReturnedFromSignIn(returnPath);
      navigate(returnPath, { replace: true });
    } else if (signedIn) {
      navigate("/", { replace: true });
    }
  }, [pathname, hash, navigate]);
  return null;
}
