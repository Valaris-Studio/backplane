// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { MouseEvent } from "react";

import { Button, LinkButton } from "../../components/Button";
import { Group, Row, RowText, RowValue } from "../../components/Group";
import { SectionHead } from "../../components/SectionHead";
import { commands, type CompanionStatus, type DisconnectResult } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { hasErrorCode } from "../../ipc/errors";
import { platformCopy } from "../../platform/copy";
import { confirmDialog, showToast } from "../../shell/layers";
import { startOnboarding } from "../../shell/navigation";
import { disconnectFailure, hostOf, plural, shortId } from "./copy";
import { openSwitchServerSheet } from "./open-switch-server-sheet";
import { WaitingUploads } from "./WaitingUploads";

// Contract v1.3: the web app lives on account.web_origin; endpoint is only the API.
function webHome(status: CompanionStatus): string | null {
  try {
    return new URL("/", status.account?.web_origin ?? status.endpoint).toString();
  } catch {
    return null;
  }
}

async function openBackplane(url: string) {
  const result = await callDaemon(() => commands.openBackplaneUrl(url));
  if (!result.ok) showToast("Couldn’t open Backplane. Try again.", { tone: "error" });
}

/** The daemon purges local data itself, even when the server can't be told; the webview deletes nothing. */
async function signOutOrThrow(): Promise<DisconnectResult> {
  const result = await callDaemon(() => commands.disconnect());
  if (result.ok) return result.value;
  // A retried sign-out after a partial failure: this Mac is already signed out.
  if (hasErrorCode(result.error, "not_connected")) return { connected: false, server_revoked: true };
  throw new Error(disconnectFailure(result.error));
}

async function confirmSignOut(event: MouseEvent<HTMLButtonElement>, host: string) {
  let outcome: DisconnectResult | null = null;
  const confirmed = await confirmDialog({
    title: `Sign out of ${host}?`,
    body: (
      <>
        <p>
          {`Capture stops and ${platformCopy().thisDevice}’s sign-in is deleted from ${platformCopy().credentialStoreName}. Agent hooks stay installed but do nothing.`}
        </p>
        <p>
          Sessions already uploaded stay in Backplane. <WaitingUploads />
        </p>
      </>
    ),
    confirmLabel: "Sign out",
    returnFocusTo: event.currentTarget,
    onConfirm: async () => {
      outcome = await signOutOrThrow();
    },
  });
  if (!confirmed || !outcome) return;
  startOnboarding();
  const { server_revoked: serverRevoked } = outcome as DisconnectResult;
  if (serverRevoked) showToast(`Signed out of ${host}.`);
  else showToast(`Signed out on ${platformCopy().thisDevice}, but ${host} couldn’t be reached. Remove ${platformCopy().thisDevice} from your devices in Backplane too.`, { tone: "info" });
}

/** The Backplane this device is connected to, and the way to switch or leave it. */
export function BackplaneSection({ status }: { status: CompanionStatus }) {
  const home = webHome(status);
  const account = status.account;
  const retentionDays = status.capture.retention_days;
  // The address people open, not the API the daemon calls (contract v1.3).
  const host = hostOf(account?.web_origin ?? status.endpoint);

  return (
    <>
      <SectionHead
        title="Backplane"
        action={
          home ? (
            <LinkButton icon="external" onClick={() => void openBackplane(home)}>
              Open in Backplane
            </LinkButton>
          ) : null
        }
      />
      <Group label="Backplane">
        <Row>
          <RowText title="Connected to" />
          <RowValue title={account?.web_origin ?? status.endpoint}>
            <span className="settings-host">{host}</span>
          </RowValue>
        </Row>
        {account ? (
          <Row>
            <RowText title="Signed in as" sub={account.display_name ?? undefined} />
            <RowValue title={account.email}>{account.email}</RowValue>
          </Row>
        ) : null}
        <Row>
          <RowText title="Device ID" />
          <RowValue title={status.installation_id}>
            <span className="settings-mono">{shortId(status.installation_id)}</span>
          </RowValue>
        </Row>
        {retentionDays !== null ? (
          <Row>
            <RowText title="Keeps sessions" />
            <RowValue title="Set by your workspace">{plural(retentionDays, "day", "days")}</RowValue>
          </Row>
        ) : null}
        <Row>
          <RowText title="Switch server" sub={`Connect ${platformCopy().thisDevice} to a different Backplane. Nothing changes until you approve it there.`} />
          <Button size="sm" onClick={(event) => openSwitchServerSheet(event.currentTarget, status.endpoint, account?.web_origin ?? null, account?.device_name ?? null)}>
            Switch server…
          </Button>
        </Row>
        <Row>
          <RowText title="Sign out" sub={`Stops capture and signs ${platformCopy().thisDevice} out of ${host}. Hooks stay installed.`} />
          <Button size="sm" variant="ghost-danger" onClick={(event) => void confirmSignOut(event, host)}>
            Sign out…
          </Button>
        </Row>
      </Group>
    </>
  );
}
