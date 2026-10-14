// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId, useState } from "react";

import { platformCopy } from "../platform/copy";
import { Disclosure } from "./Disclosure";
import { Icon } from "./Icon";
import { PRIVACY_ALWAYS, PRIVACY_LEVEL_COPY, PRIVACY_LEVEL_DETAIL, PRIVACY_LEVELS, type PrivacyLevel } from "./privacy-levels";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";
import type { RichCaptureOffer } from "../stores/rich-capture";

// Full and Rich send more than most people expect.
const WARNING_LEVELS: ReadonlySet<PrivacyLevel> = new Set(["full", "rich"]);

// Why Rich can't be chosen, when it can't.
const RICH_UNAVAILABLE: Record<Exclude<RichCaptureOffer, "offered">, string> = {
  not_offered: "Rich isn’t available on this Backplane.",
  // No policy yet, or a server that predates rich capture: true for both.
  unknown: "This Backplane hasn’t offered rich capture. It may need an update.",
  unsupported: "Update Companion to capture rich content.",
};

function levelOptions(richAvailable: boolean): SegmentOption<PrivacyLevel>[] {
  return PRIVACY_LEVELS.map((level) => ({
    value: level,
    label: PRIVACY_LEVEL_COPY[level].label,
    ...(WARNING_LEVELS.has(level) ? { tone: "warning" as const } : {}),
    ...(level === "rich" && !richAvailable ? { unavailable: true } : {}),
  }));
}

interface PrivacyLevelControlProps {
  value: PrivacyLevel;
  onValueChange: (level: PrivacyLevel) => void;
  /** The current Backplane's answer; Rich is shown but not choosable unless offered. */
  richOffer: RichCaptureOffer;
  /** The value is the automatic default rather than the owner's pick, so the note says so. */
  defaulted?: boolean;
  disabled?: boolean;
  label?: string;
}

function DetailList({ kind, heading, items }: { kind: "sent" | "kept"; heading: string; items: readonly string[] }) {
  const headingId = useId();
  return (
    <div data-list={kind}>
      <h4 id={headingId}>{heading}</h4>
      <ul aria-labelledby={headingId}>
        {items.map((item) => (
          <li key={item}>
            <Icon name={kind === "sent" ? "check" : "dash"} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Inline, not a sheet: the control already sits inside bind sheets, and sheets don't nest.
function PrivacyLevelDetail({ level }: { level: PrivacyLevel }) {
  const detail = PRIVACY_LEVEL_DETAIL[level];
  return (
    <div className="bp-privacy-detail">
      <div className="bp-privacy-cols">
        <DetailList kind="sent" heading="Sent" items={detail.sent} />
        <DetailList kind="kept" heading={`Stays on ${platformCopy().thisDevice}`} items={detail.kept} />
      </div>
      {detail.note ? <p>{detail.note}</p> : null}
      <p>{PRIVACY_ALWAYS}</p>
    </div>
  );
}

/** Metadata / Standard / Full / Rich with a plain-language line that follows the choice, and the full list behind a disclosure. */
export function PrivacyLevelControl({ value, onValueChange, richOffer, defaulted = false, disabled = false, label = "What’s sent" }: PrivacyLevelControlProps) {
  const copy = PRIVACY_LEVEL_COPY[value];
  const helpId = useId();
  const [detailOpen, setDetailOpen] = useState(false);
  const richUnavailable = richOffer === "offered" ? null : RICH_UNAVAILABLE[richOffer];
  return (
    <div>
      <SegmentedControl
        label={label}
        options={levelOptions(richOffer === "offered")}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        describedBy={helpId}
      />
      <p id={helpId} className="bp-privacy-help" data-testid="privacy-help" aria-live="polite">
        <b>{copy.lead}</b> {copy.rest}
        {richUnavailable ? (
          <span className="bp-privacy-unavailable">
            {" "}
            {richUnavailable}
            {defaulted ? ` ${PRIVACY_LEVEL_COPY[value].label} is selected for now.` : null}
          </span>
        ) : null}
      </p>
      <div className="bp-privacy-more">
        <Disclosure open={detailOpen} onOpenChange={setDetailOpen} summary={`What ${copy.label} sends, in detail`}>
          <PrivacyLevelDetail level={value} />
        </Disclosure>
      </div>
    </div>
  );
}
