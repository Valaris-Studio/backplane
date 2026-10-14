// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useCallback, useRef, useState, type FormEvent } from "react";

import { Button } from "../../components/Button";
import { Field, Input } from "../../components/Field";
import { Group, Row, RowText } from "../../components/Group";
import { SectionHead } from "../../components/SectionHead";
import { Switch } from "../../components/Switch";
import { commands, type CompanionStatus } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { launchAtLogin, notificationsEnabled, setLaunchAtLogin, setNotificationsEnabled } from "../../ipc/native";
import { platformCopy } from "../../platform/copy";
import { showToast } from "../../shell/layers";
import { DEVICE_NAME_MAX_LENGTH, renameFailure, validateDeviceName } from "./copy";
import { usePreference } from "./use-preference";

const NAME_HINT = `1 to ${DEVICE_NAME_MAX_LENGTH} characters. Press Esc to cancel.`;

async function setPaused(paused: boolean) {
  const result = await callDaemon(paused ? commands.pause : commands.resume);
  if (result.ok) showToast(paused ? `Capture paused on ${platformCopy().thisDevice}.` : "Capture resumed.");
  else showToast(paused ? "Couldn’t pause capture. Try again in a moment." : "Couldn’t resume capture. Try again in a moment.", { tone: "error" });
}

function DeviceNameRow({ deviceName }: { deviceName: string | null }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Shown until the daemon's next status carries the new name.
  const [renamed, setRenamed] = useState<{ name: string; replacing: string | null } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRenameWhenShown = useRef(false);

  // Closing the editor unmounts the focused input; without this, focus falls to <body>.
  const renameButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (button && focusRenameWhenShown.current) {
      focusRenameWhenShown.current = false;
      button.focus();
    }
  }, []);

  const shownName = renamed && renamed.replacing === deviceName ? renamed.name : deviceName;

  const startEditing = () => {
    setDraft(shownName ?? "");
    setError(null);
    setEditing(true);
  };
  const stopEditing = () => {
    focusRenameWhenShown.current = true;
    setEditing(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const name = draft.trim();
    const invalid = validateDeviceName(name);
    if (invalid) {
      setError(invalid);
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    const result = await callDaemon(() => commands.rename(name));
    setSaving(false);
    if (!result.ok) {
      setError(renameFailure(result.error));
      inputRef.current?.focus();
      return;
    }
    setRenamed({ name: result.value.name, replacing: deviceName });
    stopEditing();
    showToast("Renamed. Boards show the new name on new sessions.");
  };

  if (!editing) {
    return (
      <Row>
        <RowText title="Name" sub={shownName ?? "Not named yet"} />
        <Button ref={renameButtonRef} size="sm" onClick={startEditing}>
          Rename…
        </Button>
      </Row>
    );
  }

  return (
    <Row className="settings-rename-row">
      <form onSubmit={(event) => void submit(event)}>
        <Field
          label="Device name, shown on boards next to its sessions"
          message={error ?? NAME_HINT}
          tone={error ? "error" : "neutral"}
          onEscape={() => {
            // The rename is already on its way; closing now would hide its outcome.
            if (!saving) stopEditing();
          }}
        >
          <div className="settings-rename-controls">
            <Input
              ref={inputRef}
              value={draft}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <Button onClick={stopEditing} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving}>
              Save
            </Button>
          </div>
        </Field>
      </form>
    </Row>
  );
}

export function ThisMacSection({ status }: { status: CompanionStatus }) {
  const openAtLogin = usePreference(
    launchAtLogin,
    setLaunchAtLogin,
    platformCopy().loginItemsRefused,
  );
  const notifications = usePreference(notificationsEnabled, setNotificationsEnabled, "Couldn’t save the notification setting. Try again.");
  const [pausing, setPausing] = useState(false);

  const captureState = status.capture.state;
  const pausedLocally = captureState === "paused_locally";
  const pauseLocked = captureState === "paused_by_server" || captureState === "revoked" || status.revoked;

  // Ignored rather than disabled while in flight, so keyboard focus stays on the switch.
  const togglePause = async (paused: boolean) => {
    if (pausing) return;
    setPausing(true);
    await setPaused(paused);
    setPausing(false);
  };

  return (
    <>
      <SectionHead title={platformCopy().ThisDevice} />
      <Group label={platformCopy().ThisDevice}>
        <DeviceNameRow deviceName={status.account?.device_name ?? null} />
        <Row>
          <RowText title="Open at login" />
          <Switch
            label="Open at login"
            checked={openAtLogin.value ?? false}
            disabled={openAtLogin.value === null}
            onCheckedChange={(next) => void openAtLogin.change(next)}
          />
        </Row>
        <Row>
          <RowText title="Pause capture" sub={`Stops recording on ${platformCopy().thisDevice} until you turn it back on.`} />
          <Switch label="Pause capture" checked={pausedLocally} disabled={pauseLocked} onCheckedChange={(next) => void togglePause(next)} />
        </Row>
        <Row>
          <RowText title="Notifications" sub="Tells you when capture needs you, like an agent that broke or an update that failed." />
          <Switch
            label="Notifications"
            checked={notifications.value ?? false}
            disabled={notifications.value === null}
            onCheckedChange={(next) => void notifications.change(next)}
          />
        </Row>
      </Group>
    </>
  );
}
