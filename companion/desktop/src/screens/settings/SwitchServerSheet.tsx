// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { Field, Input } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { commands, type PairingTicket } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { hasErrorCode, type CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { pairingStore } from "../../stores/pairing";
import { isDaemonDown, pairingStartExplanation, type Explanation } from "../onboarding/daemon-messages";
import type { CodeState } from "../onboarding/onboarding-store";
import { codeStateForPairingEvent, codeStateForPollError, formatCountdown, useNow } from "../onboarding/pairing-code";
import { UserCode } from "../onboarding/UserCode";
import { serverHost, validateServerUrl, type ServerUrlCheck } from "../onboarding/server-url";
import type { PendingCode } from "./switch-pending";
import "../onboarding/onboarding.css";

const MIN_POLL_INTERVAL_S = 1;
const COPIED_FEEDBACK_MS = 2000;

const URL_HINT = "The address you open that Backplane at, starting with https://.";
const URL_PROBLEM: Record<Exclude<ServerUrlCheck, { ok: true }>["reason"], string> = {
  empty: "Enter the server’s address.",
  not_https: "Use an https:// address.",
  invalid: "That isn’t a valid web address.",
  extras: "Use just the server’s address, without ? or #.",
};

type Step =
  | { kind: "server" }
  // switching: approved, and the daemon is storing it (flushing the old
  // server first); it can no longer be cancelled or expire.
  // unconfirmed: it was switching and then lost (a daemon restart, a failed
  // store), so whether the old or the new server is connected is unknown.
  | { kind: "code"; ticket: PairingTicket; endpoint: string; issuedAt: number; codeState: CodeState; switching: boolean; unconfirmed: boolean }
  | { kind: "done"; newHost: string; oldServerRevoked: boolean | null };

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function startFailure(error: CompanionError, host: string): Explanation {
  if (isDaemonDown(error)) return { title: "Companion isn’t running", body: "Nothing changed. Try again in a moment." };
  return pairingStartExplanation(error, host);
}

// "Up to": hook events not yet processed may turn out to be outside every
// project, and the flush is bounded, so the count is a ceiling.
function waitingUploads(waiting: number): string {
  return waiting === 1 ? "up to 1 waiting upload" : `up to ${waiting} waiting uploads`;
}

function waitingUploadsLine(waiting: number | null, oldHost: string): string {
  const signsOut = `${platformCopy().thisDevice} signs out of ${oldHost}`;
  if (!waiting) return `When you approve, ${signsOut}.`;
  const verb = waiting === 1 ? "is" : "are";
  return `When you approve, ${waitingUploads(waiting)} ${verb} sent to ${oldHost} first, then ${platformCopy().thisDevice} signs out of it. Any that can’t be sent in a few seconds are deleted.`;
}

function switchingLine(waiting: number | null, newHost: string, oldHost: string): string {
  const switching = `Switching to ${newHost}.`;
  if (!waiting) return `${switching} Signing ${platformCopy().thisDevice} out of ${oldHost}.`;
  const sending = waitingUploads(waiting);
  return `${switching} Sending ${sending} to ${oldHost} first.`;
}

interface SwitchServerSheetProps {
  close: () => void;
  opener: HTMLElement | null;
  oldEndpoint: string;
  /** Where people open the current Backplane; its host is the one shown. */
  oldWebOrigin: string | null;
  deviceName: string | null;
  pending: PendingCode;
}

/**
 * Switch server: pair a new Backplane while the current one keeps
 * capturing, then let the daemon retire the old connection. Nothing changes
 * until the new code is approved; closing the sheet before that cancels it.
 */
export function SwitchServerSheet({ close, opener, oldEndpoint, oldWebOrigin, deviceName, pending }: SwitchServerSheetProps) {
  const oldHost = serverHost(oldWebOrigin ?? oldEndpoint);
  const waiting = useStoreSelector(statusStore, (status) => (status ? status.queue.records + status.queue.inbox_items : null));
  const [step, setStep] = useState<Step>({ kind: "server" });
  const [serverUrl, setServerUrl] = useState("");
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ explanation: Explanation; onAddress: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const mounted = useRef(true);
  const urlRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const now = useNow();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(copiedTimer.current);
    };
  }, []);

  const pairingId = step.kind === "code" ? step.ticket.pairing_id : null;

  // Each step leads with its own content for keyboard and screen-reader users.
  useLayoutEffect(() => {
    if (step.kind === "code") codeRef.current?.focus({ preventScroll: true });
    if (step.kind === "done") doneRef.current?.focus({ preventScroll: true });
  }, [step.kind, pairingId]);

  const requestCode = async (endpoint: string) => {
    setStartError(null);
    setStarting(true);
    const result = await callDaemon(() => commands.pairStart(endpoint, deviceName, true));
    if (!mounted.current) {
      // Closed meanwhile: nobody will show this code, so it must not stay approvable.
      if (result.ok) void callDaemon(() => commands.pairCancel(result.value.pairing_id));
      return;
    }
    setStarting(false);
    if (!result.ok) {
      const code = result.error.kind === "api" ? result.error.code : "";
      setStartError({ explanation: startFailure(result.error, serverHost(endpoint)), onAddress: code === "server_unreachable" || code === "server_rejected" });
      if (step.kind === "code") setStep({ kind: "server" });
      return;
    }
    pending.hold(result.value.pairing_id);
    setOpenFailed(false);
    setStep({ kind: "code", ticket: result.value, endpoint, issuedAt: Date.now(), codeState: { kind: "waiting" }, switching: false, unconfirmed: false });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (starting) return;
    const check = validateServerUrl(serverUrl);
    if (!check.ok) {
      setUrlProblem(URL_PROBLEM[check.reason]);
      urlRef.current?.focus();
      return;
    }
    if (sameOrigin(check.url, oldEndpoint) || (oldWebOrigin !== null && sameOrigin(check.url, oldWebOrigin))) {
      setUrlProblem(`${platformCopy().ThisDevice} is already connected to ${oldHost}.`);
      urlRef.current?.focus();
      return;
    }
    void requestCode(check.url);
  };

  const settleCode = (id: string, codeState: CodeState) => {
    if (codeState.kind !== "waiting" && codeState.kind !== "offline" && pending.holds(id)) pending.release();
    const settled = codeState.kind !== "waiting" && codeState.kind !== "offline";
    setStep((current) =>
      current.kind === "code" && current.ticket.pairing_id === id
        ? { ...current, codeState, switching: false, unconfirmed: current.unconfirmed || (current.switching && settled) }
        : current,
    );
  };

  const markSwitching = (id: string) => {
    setStep((current) => (current.kind === "code" && current.ticket.pairing_id === id ? { ...current, switching: true } : current));
  };

  // Cancel, Close, Escape and the scrim all come here: a code approved in the
  // meantime is already switching, so the sheet stays to show it finish.
  const cancel = async () => {
    const id = pending.release();
    if (id) {
      const result = await callDaemon(() => commands.pairCancel(id));
      if (!result.ok && hasErrorCode(result.error, "pairing_persisting")) {
        pending.hold(id);
        markSwitching(id);
        return;
      }
    }
    close();
  };

  const poll = async (id: string) => {
    const result = await callDaemon(() => commands.pairPoll(id));
    if (!mounted.current || !pending.holds(id)) return;
    if (result.ok) {
      if (result.value.state === "connected") {
        pending.release();
        setStep((current) =>
          current.kind === "code" && current.ticket.pairing_id === id
            ? { kind: "done", newHost: serverHost(current.endpoint), oldServerRevoked: result.value.state === "connected" ? result.value.old_server_revoked : null }
            : current,
        );
        return;
      }
      if (result.value.state === "persisting") {
        markSwitching(id);
        return;
      }
      settleCode(id, { kind: "waiting" });
      return;
    }
    settleCode(id, codeStateForPollError(result.error) ?? { kind: "failed", title: "Companion isn’t running", body: "Nothing changed. Try again in a moment." });
  };

  // The stream settles the pairing as soon as the daemon learns of it; the
  // poll is the fallback, and the only source of the old server's outcome.
  useEffect(() => {
    if (!pairingId) return;
    return pairingStore.subscribe(() => {
      const event = pairingStore.get();
      if (!event || event.pairing_id !== pairingId || !pending.holds(pairingId)) return;
      if (event.state === "connected") {
        void poll(pairingId);
        return;
      }
      if (event.state === "persisting") {
        markSwitching(pairingId);
        return;
      }
      const settled = codeStateForPairingEvent(event.state);
      if (settled) settleCode(pairingId, settled);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll and settleCode only read refs and setters
  }, [pairingId]);

  const live = step.kind === "code" && (step.switching || step.codeState.kind === "waiting" || step.codeState.kind === "offline");
  const intervalMs = step.kind === "code" ? Math.max(step.ticket.interval, MIN_POLL_INTERVAL_S) * 1000 : 0;
  useEffect(() => {
    if (!live || !pairingId) return;
    const timer = setInterval(() => void poll(pairingId), intervalMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll only reads refs and setters
  }, [live, pairingId, intervalMs]);

  const copyCode = async (code: string) => {
    clearTimeout(copiedTimer.current);
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
    }
  };

  const openApproval = async (url: string) => {
    const result = await callDaemon(() => commands.openBackplaneUrl(url));
    setOpenFailed(!result.ok);
  };

  if (step.kind === "done") {
    return (
      <Sheet
        title="Switch server"
        onClose={close}
        returnFocusTo={opener}
        footer={
          <Button ref={doneRef} variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <div className="settings-switch-body">
          <div className="settings-switch-done" role="status">
            <Icon name="check" />
            <p>
              Now connected to <b>{step.newHost}</b>. Signed out of <b>{oldHost}</b>.
            </p>
          </div>
          {step.oldServerRevoked === false ? (
            <Banner tone="info" title={`${oldHost} couldn’t be reached, so it may still list ${platformCopy().thisDevice}. Remove it from your devices there.`} />
          ) : null}
        </div>
      </Sheet>
    );
  }

  if (step.kind === "code" && step.unconfirmed) {
    return (
      <Sheet
        title="Switch server"
        onClose={close}
        returnFocusTo={opener}
        footer={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <div className="settings-switch-body">
          <div className="settings-switch-progress" role="status">
            <Icon name="info" />
            <p>
              <b>Couldn’t confirm the switch.</b> {`Companion lost track of it, for example after a restart. Connected to in Settings shows which Backplane ${platformCopy().thisDevice} is on now.`}
            </p>
          </div>
        </div>
      </Sheet>
    );
  }

  if (step.kind === "code" && step.switching) {
    const newHost = serverHost(step.endpoint);
    return (
      <Sheet
        title="Switch server"
        onClose={() => {}}
        dismissible={false}
        returnFocusTo={opener}
        footer={
          <Button variant="primary" loading disabled>
            Switching…
          </Button>
        }
      >
        <div className="settings-switch-body">
          <div className="settings-switch-progress" role="status">
            <Spinner />
            <p>{switchingLine(waiting, newHost, oldHost)}</p>
          </div>
          <p className="settings-sheet-note">This takes a few seconds and can’t be cancelled now that the code is approved.</p>
        </div>
      </Sheet>
    );
  }

  if (step.kind === "code") {
    const { ticket, codeState } = step;
    const newHost = serverHost(step.endpoint);
    const expiresAt = Date.parse(ticket.expires_at);
    const remainingMs = Math.max(0, expiresAt - now);
    const shown: CodeState = live && remainingMs === 0 ? { kind: "expired" } : codeState;
    const shownLive = shown.kind === "waiting" || shown.kind === "offline";
    const stillConnected = `${platformCopy().ThisDevice} is still connected to ${oldHost}.`;
    return (
      <Sheet
        title="Switch server"
        onClose={() => void cancel()}
        returnFocusTo={opener}
        footer={
          <>
            <Button onClick={() => void cancel()}>Cancel</Button>
            {shownLive ? (
              <Button variant="primary" trailingIcon="external" onClick={() => void openApproval(ticket.verification_uri_complete)}>
                Open Backplane
              </Button>
            ) : (
              <Button variant="primary" loading={starting} onClick={() => void requestCode(step.endpoint)}>
                {shown.kind === "denied" ? "Start again" : shown.kind === "failed" ? "Try again" : "Get a new code"}
              </Button>
            )}
          </>
        }
      >
        <div className="settings-switch-body">
          <p className="settings-sheet-lede">
            Approve this code in Backplane at <b>{newHost}</b>.
          </p>
          {startError ? (
            <Banner tone="error" role="alert" title={startError.explanation.title}>
              {startError.explanation.body}
            </Banner>
          ) : shown.kind === "expired" ? (
            <Banner tone="warning" role="alert" title="This code expired">
              {`Get a new one to carry on. ${stillConnected}`}
            </Banner>
          ) : shown.kind === "denied" ? (
            <Banner tone="error" icon="x" role="alert" title="The request was declined in Backplane">
              {`${stillConnected} If you didn’t decline it, start again.`}
            </Banner>
          ) : shown.kind === "failed" ? (
            <Banner tone="error" role="alert" title={shown.title}>
              {`${shown.body} ${stillConnected}`}
            </Banner>
          ) : shown.kind === "offline" ? (
            <Banner tone="warning" icon="cloud-off" role="alert" title={`Can’t reach ${newHost}`}>
              Check your connection. The code is still valid.
            </Banner>
          ) : null}
          <div className="ob-code-card" data-state={shown.kind}>
            <UserCode code={ticket.user_code} codeRef={codeRef} />
            {shownLive ? (
              <>
                <div className="ob-code-row">
                  <Button size="sm" icon={copied ? "check" : "copy"} onClick={() => void copyCode(ticket.user_code)}>
                    {copied ? "Copied" : "Copy code"}
                  </Button>
                </div>
                <div className="ob-code-status settings-switch-waiting" role="status">
                  {shown.kind === "offline" ? <Icon name="cloud-off" /> : <Spinner />}
                  <span>
                    {shown.kind === "offline" ? "Retrying on its own" : "Waiting for approval"} · expires in <span className="tabular-nums">{formatCountdown(remainingMs)}</span>
                  </span>
                </div>
              </>
            ) : null}
          </div>
          {shownLive && openFailed ? (
            <p className="ob-code-help" role="status">
              Couldn’t open Backplane from here. Go to <b className="ob-selectable">{ticket.verification_uri}</b> and enter the code.
            </p>
          ) : null}
          <p className="settings-sheet-note">{waitingUploadsLine(waiting, oldHost)}</p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Switch server"
      onClose={close}
      initialFocusRef={urlRef}
      returnFocusTo={opener}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" form="switch-server-form" variant="primary" loading={starting}>
            Continue
          </Button>
        </>
      }
    >
      <form id="switch-server-form" className="settings-switch-body" noValidate onSubmit={onSubmit}>
        <p className="settings-sheet-lede">
          {`Connect ${platformCopy().thisDevice} to a different Backplane. It keeps capturing for `}
          <b>{oldHost}</b>
          {" until you approve the new one."}
        </p>
        {startError && !startError.onAddress ? (
          <Banner tone="error" role="alert" title={startError.explanation.title}>
            {startError.explanation.body}
          </Banner>
        ) : null}
        <Field
          label="Server address"
          message={urlProblem ?? (startError?.onAddress ? <span role="alert">{`${startError.explanation.title}. ${startError.explanation.body}`}</span> : URL_HINT)}
          tone={urlProblem || startError?.onAddress ? "error" : "neutral"}
        >
          <Input
            ref={urlRef}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="https://backplane.example.com"
            value={serverUrl}
            onChange={(event) => {
              setServerUrl(event.target.value);
              setUrlProblem(null);
              setStartError(null);
            }}
          />
        </Field>
      </form>
    </Sheet>
  );
}
