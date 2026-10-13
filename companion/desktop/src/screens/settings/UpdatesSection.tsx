// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId } from "react";

import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { Group, Row, RowText } from "../../components/Group";
import { Icon } from "../../components/Icon";
import { SectionHead } from "../../components/SectionHead";
import { Select } from "../../components/Select";
import { Spinner } from "../../components/Spinner";
import type { UpdateChannel } from "../../ipc/bindings";
import { platformCopy } from "../../platform/copy";
import { formatCheckedAt, rolledBackCopy } from "./copy";
import type { Updates } from "./use-updates";

const UPDATE_CHANNELS: ReadonlySet<string> = new Set<UpdateChannel>(["stable", "beta"]);

function isUpdateChannel(value: string): value is UpdateChannel {
  return UPDATE_CHANNELS.has(value);
}

/** Drawn at the top of Settings, above This Mac, as in the mockup. */
export function UpdateBanners({ updates }: { updates: Updates }) {
  const { state, rolledBack } = updates;
  const rolledBackText = rolledBack ? rolledBackCopy(rolledBack) : null;
  const offered = state.phase === "available" || state.phase === "installing" ? state : null;

  return (
    <>
      {rolledBackText ? <Banner title={rolledBackText.title}>{rolledBackText.body}</Banner> : null}
      {offered ? (
        <Banner
          tone="success"
          icon="download"
          title={`Companion ${offered.version} is ready`}
          actions={
            <Button size="sm" variant="primary" loading={offered.phase === "installing"} onClick={() => void updates.install()}>
              {offered.phase === "installing" ? "Restarting…" : "Restart to update"}
            </Button>
          }
        >
          <p className="settings-banner-copy">Restarting takes a second. Capture resumes on its own, and nothing in progress is lost.</p>
          <div role="alert">{offered.phase === "available" && offered.installError ? <p className="settings-banner-error">{offered.installError}</p> : null}</div>
        </Banner>
      ) : null}
    </>
  );
}

function CheckState({ updates }: { updates: Updates }) {
  switch (updates.state.phase) {
    case "checking":
      return (
        <span className="settings-update-state">
          <Spinner />
          Checking…
        </span>
      );
    case "current":
      return (
        <span className="settings-update-state" data-tone="success">
          <Icon name="check" size={13} />
          Up to date
        </span>
      );
    case "idle":
    case "check_failed":
      return (
        <Button size="sm" onClick={() => void updates.check()}>
          Check now
        </Button>
      );
    default:
      return null;
  }
}

export function UpdatesSection({ updates, runningVersion }: { updates: Updates; runningVersion: string }) {
  const channelId = useId();
  const { state, checkedAt, channel } = updates;
  const unknownChannel = channel !== null && !isUpdateChannel(channel) ? channel : null;
  const versionLine = checkedAt ? `${runningVersion} · ${formatCheckedAt(checkedAt)}` : runningVersion;

  return (
    <>
      <SectionHead title="Updates" />
      <Group label="Updates">
        <Row>
          <span className="bp-row-text">
            <label htmlFor={channelId}>Channel</label>
            {unknownChannel ? <span className="bp-row-sub">{`${platformCopy().ThisDevice} is on the “${unknownChannel}” channel, which Settings can’t change.`}</span> : null}
          </span>
          <Select
            id={channelId}
            value={channel ?? "stable"}
            disabled={channel === null || unknownChannel !== null}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (isUpdateChannel(next)) void updates.changeChannel(next);
            }}
          >
            {unknownChannel ? <option value={unknownChannel}>{unknownChannel}</option> : null}
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </Select>
        </Row>
        <Row>
          <RowText
            title="Version"
            sub={
              <>
                {versionLine}
                <span role="alert">{state.phase === "check_failed" ? <span className="settings-inline-error">{state.message}</span> : null}</span>
              </>
            }
          />
          <span role="status" aria-live="polite" className="settings-update-slot">
            <CheckState updates={updates} />
          </span>
        </Row>
      </Group>
    </>
  );
}
