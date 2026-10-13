// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence } from "motion/react";
import { useRef, useState, type FormEvent } from "react";

import { Banner } from "../../components/Banner";
import { Button, IconButton } from "../../components/Button";
import { Field, Input } from "../../components/Field";
import { RowText } from "../../components/Group";
import { Switch } from "../../components/Switch";
import type { SettingsUpdate_Deserialize } from "../../ipc/bindings";
import { MotionListItem } from "../../motion/MotionListItem";
import { platformCopy } from "../../platform/copy";
import { showToast } from "../../shell/layers";
import { refreshAfterPolicyChange } from "../../stores/projects";
import { RULE_REFUSED, failureKind, failureReason } from "./copy";
import { useLeavingRowFocus } from "./leaving-focus";
import { queueRulesWrite, useRules, type Rules } from "./rules-store";
import { validateNewRule } from "./rules-validation";
import { SectionHeading } from "./SectionHeading";

const FOCUS_PREFIX = "rule:";

function rulesCount(count: number): string {
  return count === 1 ? "1 rule" : `${count} rules`;
}

function AwaitingConfirmationNotice() {
  return (
    <Banner tone="info" title="Backplane hasn’t confirmed your last change yet.">
      Rules can be changed again as soon as it does.
    </Banner>
  );
}

function UnknownRulesNotice() {
  return (
    <Banner tone="info" title="Your current rules aren’t available yet.">
      {`They show here once ${platformCopy().thisDevice} has its capture policy from Backplane. Until then they can’t be changed here, so nothing gets overwritten.`}
    </Banner>
  );
}

export function RulesPanel() {
  const { rules, awaitingConfirmation } = useRules();
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const globs = rules?.exclude_globs ?? [];
  const focusFromLeavingRow = useLeavingRowFocus(globs, FOCUS_PREFIX, inputRef);
  const readOnly = rules === null || awaitingConfirmation;
  const locked = readOnly || saving;

  const run = async (build: (current: Rules) => SettingsUpdate_Deserialize) => {
    setSaving(true);
    const result = await queueRulesWrite(build);
    setSaving(false);
    if (result.ok) refreshAfterPolicyChange();
    return result;
  };

  const toggleAutoMatch = async (next: boolean) => {
    const result = await run(() => ({ auto_match_repos: next }));
    if (!result.ok) showToast(`Couldn’t save your rules. ${failureReason(result.error)}`, { tone: "error" });
  };

  const addRule = async (event: FormEvent) => {
    event.preventDefault();
    if (!rules || locked) return;
    const check = validateNewRule(draft, rules.exclude_globs);
    if (!check.ok) {
      setDraftError(check.message);
      inputRef.current?.focus();
      return;
    }
    const rule = check.rule;
    const result = await run((current) => ({
      exclude_globs: current.exclude_globs.includes(rule) ? [...current.exclude_globs] : [...current.exclude_globs, rule],
    }));
    if (result.ok) {
      setDraft("");
      setDraftError(null);
    } else if (failureKind(result.error) === "invalid_request") {
      setDraftError(RULE_REFUSED);
    } else {
      showToast(`Couldn’t save your rules. ${failureReason(result.error)}`, { tone: "error" });
    }
    inputRef.current?.focus();
  };

  const removeRule = async (glob: string) => {
    const result = await run((current) => ({ exclude_globs: current.exclude_globs.filter((candidate) => candidate !== glob) }));
    if (result.ok) showToast(`Removed ${glob}.`);
    else showToast(`Couldn’t save your rules. ${failureReason(result.error)}`, { tone: "error" });
  };

  return (
    <section>
      {rules === null ? <UnknownRulesNotice /> : awaitingConfirmation ? <AwaitingConfirmationNotice /> : null}
      <SectionHeading title="Matching" />
      <ul className="bp-group">
        <li className="bp-row">
          <RowText
            title="Bind repositories automatically"
            // Auto-match binds silently at Standard, so this line is where consent is asked.
            sub="When a repository’s remote is linked to exactly one board, bind it with the Standard level, which sends your prompts and commands."
          />
          <Switch
            checked={rules?.auto_match_repos ?? false}
            label="Bind repositories automatically"
            disabled={locked}
            onCheckedChange={(next) => void toggleAutoMatch(next)}
          />
        </li>
      </ul>

      <SectionHeading title="Never capture" aside={rules ? rulesCount(globs.length) : undefined} />
      <ul className="bp-group projects-list" aria-label="Never capture rules">
        <AnimatePresence initial={false}>
          {globs.map((glob) => (
            <MotionListItem key={glob} className="bp-row" data-row-key={glob} onFocusCapture={() => focusFromLeavingRow(glob)}>
              <span className="bp-row-text projects-glob">{glob}</span>
              <IconButton icon="x" label={`Remove rule ${glob}`} data-focus-key={FOCUS_PREFIX + glob} disabled={locked} onClick={() => void removeRule(glob)} />
            </MotionListItem>
          ))}
        </AnimatePresence>
      </ul>
      <form className="projects-rule-form" onSubmit={(event) => void addRule(event)} noValidate>
        <Field label="New folder pattern" labelHidden message={draftError ?? undefined} tone={draftError ? "error" : "neutral"} className="projects-rule-field">
          <Input
            ref={inputRef}
            className="projects-glob"
            placeholder="~/clients/**"
            value={draft}
            disabled={readOnly}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftError(null);
            }}
          />
        </Field>
        <Button type="submit" disabled={readOnly} loading={saving}>
          Add
        </Button>
      </form>
      <p className="bp-help">
        Folders matching these patterns are never captured, even when a board matches. <span className="projects-mono">**</span> matches any depth.
      </p>
    </section>
  );
}
