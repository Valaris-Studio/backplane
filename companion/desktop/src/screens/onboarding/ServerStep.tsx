// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useRef, useState, type FormEvent } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { Field, Input } from "../../components/Field";
import type { CompanionError } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import { prefilledServer } from "./constants";
import { DaemonDownPanel } from "./DaemonDownPanel";
import { checkDeviceName } from "./device-name";
import { errorCode, isDaemonDown, pairingStartExplanation } from "./daemon-messages";
import { statusStore } from "../../stores/daemon-stream";
import { useStoreSelector } from "../../stores/external-store";
import { goToStep, onboardingStore, setDeviceNameDraft } from "./onboarding-store";
import { OnboardingFrame } from "./OnboardingFrame";
import { disconnectThenPair, startPairing } from "./pairing-actions";
import { serverHost, validateServerUrl, type ServerUrlCheck } from "./server-url";

const URL_HINT = "Use the address you open Backplane at, starting with https://.";
const URL_PROBLEM: Record<Exclude<ServerUrlCheck, { ok: true }>["reason"], string> = {
  empty: "Enter your server’s address.",
  not_https: "Use an https:// address.",
  invalid: "That isn’t a valid web address.",
  extras: "Use just the server’s address, without ? or #.",
};

const deviceNameHint = () => `Shown in Backplane next to ${platformCopy().thisDevice}’s sessions.`;

// Errors about the address itself, as opposed to this device or the daemon.
const SERVER_ERROR_CODES = new Set(["server_unreachable", "server_rejected"]);

export function ServerStep() {
  const [serverUrl, setServerUrl] = useState(prefilledServer);
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ error: CompanionError; endpoint: string; deviceName: string | null } | null>(null);
  const busy = useStoreSelector(onboardingStore, (state) => state.startingAttempt !== null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const suggestedName = useStoreSelector(statusStore, (status) => status?.suggested_device_name ?? null);
  const platform = useStoreSelector(statusStore, (status) => status?.companion.platform ?? null);
  const nameDraft = useStoreSelector(onboardingStore, (state) => state.deviceNameDraft);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const shownName = nameDraft ?? suggestedName ?? "";

  const run = async (endpoint: string, deviceName: string | null, attempt: (endpoint: string, deviceName: string | null) => Promise<CompanionError | null>) => {
    setFailure(null);
    const error = await attempt(endpoint, deviceName);
    if (error) setFailure({ error, endpoint, deviceName });
  };

  const chosenEndpoint = (): string | null => {
    const check = validateServerUrl(serverUrl);
    if (check.ok) return check.url;
    setUrlProblem(URL_PROBLEM[check.reason]);
    urlInputRef.current?.focus();
    return null;
  };

  const chosenDeviceName = (): { name: string | null } | null => {
    const check = checkDeviceName(shownName);
    if (check.ok) return { name: check.name };
    setNameProblem(check.problem);
    nameInputRef.current?.focus();
    return null;
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const endpoint = chosenEndpoint();
    if (!endpoint) return;
    const deviceName = chosenDeviceName();
    if (deviceName) void run(endpoint, deviceName.name, startPairing);
  };

  const failedOnAddress = failure !== null && SERVER_ERROR_CODES.has(errorCode(failure.error) ?? "");
  const explanation = failure && !isDaemonDown(failure.error) ? pairingStartExplanation(failure.error, serverHost(failure.endpoint)) : null;
  const revoked = failure !== null && errorCode(failure.error) === "unauthorized_device";

  return (
    <form className="contents" noValidate onSubmit={onSubmit}>
      <OnboardingFrame
        step="server"
        title="Where is your Backplane?"
        lede="Connect to the Backplane your team signs in to. You can change it later only by disconnecting."
        onBack={() => goToStep("welcome", "pop")}
        actions={
          <Button type="submit" variant="primary" loading={busy}>
            Continue
          </Button>
        }
      >
        {failure && isDaemonDown(failure.error) ? (
          <DaemonDownPanel retrying={busy} onRetry={() => void run(failure.endpoint, failure.deviceName, startPairing)} />
        ) : (
          <>
            {explanation ? (
              <Banner
                tone="error"
                role="alert"
                title={explanation.title}
                actions={
                  revoked && failure ? (
                    <Button size="sm" loading={busy} onClick={() => void run(failure.endpoint, failure.deviceName, disconnectThenPair)}>
                      Start again
                    </Button>
                  ) : undefined
                }
              >
                {explanation.body}
              </Banner>
            ) : null}
            <Field label="Server address" message={urlProblem ?? (failedOnAddress && explanation ? explanation.body : URL_HINT)} tone={urlProblem || failedOnAddress ? "error" : "neutral"}>
              <Input
                ref={urlInputRef}
                type="url"
                inputMode="url"
                required
                autoComplete="url"
                spellCheck={false}
                placeholder="https://backplane.example.com"
                value={serverUrl}
                onChange={(event) => {
                  setServerUrl(event.target.value);
                  setUrlProblem(null);
                }}
              />
            </Field>
            <Field label="Device name" message={nameProblem ?? deviceNameHint()} tone={nameProblem ? "error" : "neutral"} className="ob-device-name">
              <Input
                ref={nameInputRef}
                value={shownName}
                placeholder={platform ? `A generic name, like ${platform.replace("/", "-")}-…` : "A generic name"}
                onChange={(event) => {
                  setDeviceNameDraft(event.target.value);
                  setNameProblem(null);
                }}
              />
            </Field>
          </>
        )}
      </OnboardingFrame>
    </form>
  );
}
