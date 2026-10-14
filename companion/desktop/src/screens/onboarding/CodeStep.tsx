// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Spinner } from "../../components/Spinner";
import { commands } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import { DaemonDownPanel } from "./DaemonDownPanel";
import { pairingStartExplanation } from "./daemon-messages";
import { useStoreSelector } from "../../stores/external-store";
import { usePairingEvents } from "../../stores/pairing";
import { consumeFocusNewCode, markConnected, onboardingStore, setCodeState, type CodeState, type PendingPairing } from "./onboarding-store";
import { OnboardingFrame } from "./OnboardingFrame";
import { codeStateForPairingEvent, codeStateForPollError, formatCountdown, useNow } from "./pairing-code";
import { UserCode } from "./UserCode";
import { cancelPairing, startPairing } from "./pairing-actions";
import { serverHost } from "./server-url";

const COPIED_FEEDBACK_MS = 2000;
const MIN_POLL_INTERVAL_S = 1;

export function CodeStep({ pairing }: { pairing: PendingPairing }) {
  const { ticket, endpoint, deviceName, issuedAt, codeState } = pairing;
  const pairingId = ticket.pairing_id;
  const host = serverHost(endpoint);
  const now = useNow();
  const expiresAt = Date.parse(ticket.expires_at);
  const remainingMs = Math.max(0, expiresAt - now);
  const lifetimeMs = Math.max(1, expiresAt - issuedAt);

  // False once Back or a new code replaced this pairing, while this view is still sliding out.
  const current = useStoreSelector(onboardingStore, (state) => state.pairing?.ticket.pairing_id === pairingId);
  const polling = codeState.kind === "waiting" || codeState.kind === "offline";
  // The clock can run out before the daemon says so; stop asking once it has.
  const shown: CodeState = polling && remainingMs === 0 ? { kind: "expired" } : codeState;
  const live = shown.kind === "waiting" || shown.kind === "offline";

  const [daemonDown, setDaemonDown] = useState(false);
  const [pollRequest, setPollRequest] = useState({ id: 0, delayMs: Math.max(ticket.interval, MIN_POLL_INTERVAL_S) * 1000 });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">("idle");
  const [openFailed, setOpenFailed] = useState(false);
  const restarting = useStoreSelector(onboardingStore, (state) => state.startingAttempt !== null);
  const [restartError, setRestartError] = useState<CompanionError | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // The stream settles the pairing as soon as the daemon learns of it; polling stays as the fallback.
  const pairingEvent = usePairingEvents(pairingId);
  useEffect(() => {
    if (!pairingEvent || !current) return;
    if (pairingEvent.state === "connected") {
      markConnected();
      return;
    }
    const settled = codeStateForPairingEvent(pairingEvent.state);
    if (settled) setCodeState(pairingId, settled);
  }, [pairingEvent, current, pairingId]);

  // "Get a new code" replaces this view in place; keyboard users land on the new code.
  useLayoutEffect(() => {
    if (consumeFocusNewCode()) codeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!live || !current || daemonDown) return;
    const intervalMs = Math.max(ticket.interval, MIN_POLL_INTERVAL_S) * 1000;
    let cancelled = false;
    const pollAgain = () => setPollRequest((request) => ({ id: request.id + 1, delayMs: intervalMs }));
    const timer = setTimeout(async () => {
      const result = await callDaemon(() => commands.pairPoll(pairingId));
      if (cancelled) return;
      if (result.ok) {
        if (result.value.state === "connected") {
          markConnected();
          return;
        }
        setCodeState(pairingId, { kind: "waiting" });
        pollAgain();
        return;
      }
      const next = codeStateForPollError(result.error);
      if (!next) {
        setDaemonDown(true);
        return;
      }
      setCodeState(pairingId, next);
      if (next.kind === "waiting" || next.kind === "offline") pollAgain();
    }, pollRequest.delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, current, daemonDown, pairingId, ticket.interval, pollRequest]);

  const resumeAfterDaemonDown = () => {
    setDaemonDown(false);
    setPollRequest((request) => ({ id: request.id + 1, delayMs: 0 }));
  };

  const copyCode = async () => {
    clearTimeout(copiedTimer.current);
    try {
      await navigator.clipboard.writeText(ticket.user_code);
      setCopyState("copied");
      copiedTimer.current = setTimeout(() => setCopyState("idle"), COPIED_FEEDBACK_MS);
    } catch {
      // The webview can refuse clipboard writes; leave the code selected for a copy shortcut instead.
      const code = codeRef.current;
      if (code) window.getSelection()?.selectAllChildren(code);
      setCopyState("blocked");
    }
  };

  const openBackplane = async () => {
    const result = await callDaemon(() => commands.openBackplaneUrl(ticket.verification_uri_complete));
    setOpenFailed(!result.ok);
  };

  const getNewCode = async () => {
    setRestartError(null);
    const error = await startPairing(endpoint, deviceName);
    setRestartError(error);
  };

  const restartExplanation = restartError ? pairingStartExplanation(restartError, host) : null;

  return (
    <OnboardingFrame
      step="code"
      title={`Approve ${platformCopy().thisDevice} in Backplane`}
      lede={`Open Backplane and confirm the code below. It proves ${platformCopy().thisDevice} belongs to you, without typing a password here.`}
      onBack={cancelPairing}
      actions={
        live ? (
          <Button variant="primary" trailingIcon="external" onClick={() => void openBackplane()}>
            Open Backplane
          </Button>
        ) : (
          <Button variant="primary" loading={restarting} onClick={() => void getNewCode()}>
            {shown.kind === "denied" ? "Start again" : shown.kind === "failed" ? "Try again" : "Get a new code"}
          </Button>
        )
      }
    >
      {daemonDown ? (
        <DaemonDownPanel onRetry={resumeAfterDaemonDown} />
      ) : (
        <>
          {restartExplanation ? (
            <Banner tone="error" role="alert" title={restartExplanation.title}>
              {restartExplanation.body}
            </Banner>
          ) : shown.kind === "expired" ? (
            <Banner tone="warning" role="alert" title="This code expired">
              Codes last {Math.max(1, Math.round(lifetimeMs / 60_000))} minutes. Get a new one and try again.
            </Banner>
          ) : shown.kind === "denied" ? (
            <Banner tone="error" icon="x" role="alert" title="The request was declined in Backplane">
              {`${platformCopy().ThisDevice} stays disconnected. If you didn’t decline it, start again.`}
            </Banner>
          ) : shown.kind === "failed" ? (
            <Banner tone="error" role="alert" title={shown.title}>
              {shown.body}
            </Banner>
          ) : shown.kind === "offline" ? (
            <Banner tone="warning" icon="cloud-off" role="alert" title={`Can’t reach ${host}`}>
              Check your connection. The code is still valid, so you can keep approving it.
            </Banner>
          ) : null}
          <div className="ob-code-card" data-testid="code-card" data-state={shown.kind}>
            <UserCode code={ticket.user_code} codeRef={codeRef} />
            {live ? (
              <>
                <div className="ob-code-row">
                  <Button size="sm" icon={copyState === "copied" ? "check" : "copy"} onClick={() => void copyCode()}>
                    {copyState === "copied" ? "Copied" : "Copy code"}
                  </Button>
                </div>
                {/* Always mounted, so both outcomes are announced politely. */}
                <p className="ob-code-help" role="status" data-testid="copy-status">
                  {copyState === "blocked" ? `Copying isn’t allowed here. The code is selected, so press ${platformCopy().copyShortcut}.` : null}
                  {copyState === "copied" ? <span className="sr-only">Code copied</span> : null}
                </p>
                <progress className="ob-meter" data-testid="code-meter" max={1} value={remainingMs / lifetimeMs} aria-hidden="true" />
                <div className="ob-code-status" role="status">
                  {shown.kind === "offline" ? <Icon name="cloud-off" /> : <Spinner />}
                  <span>{shown.kind === "offline" ? "Can’t reach the server. Retrying on its own." : "Waiting for you to approve in Backplane"}</span>
                </div>
                <div className="ob-code-status">
                  <span>
                    Expires in <span className="tabular-nums">{formatCountdown(remainingMs)}</span>
                  </span>
                </div>
              </>
            ) : null}
          </div>
          {live && openFailed ? (
            <p className="ob-code-help" role="status">
              Couldn’t open Backplane from here. Go to <b className="ob-selectable">{ticket.verification_uri}</b> and enter the code.
            </p>
          ) : null}
        </>
      )}
    </OnboardingFrame>
  );
}
