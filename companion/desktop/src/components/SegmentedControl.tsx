// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId, type KeyboardEvent } from "react";

import { tabStopIndex, useRovingSelection } from "./roving-focus";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Tints the selected segment's text, e.g. warning for the Full privacy level. */
  tone?: "warning";
  /** Shown but not choosable, e.g. a level this Backplane doesn't offer; arrows skip it. */
  unavailable?: boolean;
}

interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  /** Id of text that explains the current choice (PrivacyLevelControl's help line). */
  describedBy?: string;
}

export function SegmentedControl<T extends string>({ label, options, value, onValueChange, disabled = false, className = "", describedBy }: SegmentedControlProps<T>) {
  const choosable = options.filter((option) => !option.unavailable);
  const select = (next: T) => {
    if (!disabled && next !== value && choosable.some((option) => option.value === next)) onValueChange(next);
  };
  const values = choosable.map((option) => option.value);
  const roving = useRovingSelection(values, select, '[role="radio"]:not([data-unavailable])', disabled);
  // The checked radio is the tab stop even when it can no longer be chosen.
  const tabStopValue = options.some((option) => option.value === value) ? value : values[tabStopIndex(values, value)];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = options.findIndex((option) => option.unavailable && option.value === (event.target as HTMLElement).dataset.level);
    if (from === -1) return roving.onKeyDown(event);
    // From a checked level that can't be chosen, arrows step to the nearest one that can.
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || disabled) return;
    for (let offset = 1; offset < options.length; offset += 1) {
      const next = options[(from + step * offset + options.length) % options.length];
      if (!next || next.unavailable) continue;
      event.preventDefault();
      event.currentTarget.querySelector<HTMLElement>(`[data-level="${next.value}"]`)?.focus();
      select(next.value);
      return;
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      className={`bp-seg ${className}`}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={disabled || option.unavailable || undefined}
            tabIndex={!disabled && option.value === tabStopValue ? 0 : -1}
            data-level={option.value}
            data-unavailable={option.unavailable || undefined}
            data-tone={option.tone}
            onClick={() => select(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  title: string;
  description?: string;
}

interface ChoiceGroupProps<T extends string> {
  label: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  disabled?: boolean;
}

/** Full-width radio cards (the onboarding server picker). */
export function ChoiceGroup<T extends string>({ label, options, value, onValueChange, disabled = false }: ChoiceGroupProps<T>) {
  const select = (next: T) => {
    if (!disabled && next !== value) onValueChange(next);
  };
  const values = options.map((option) => option.value);
  const roving = useRovingSelection(values, select, '[role="radio"]', disabled);
  const tabStop = tabStopIndex(values, value);
  const idBase = useId();
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={roving.onKeyDown}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={disabled || undefined}
            tabIndex={!disabled && index === tabStop ? 0 : -1}
            className="bp-choice"
            aria-labelledby={`${idBase}-${index}-title`}
            aria-describedby={option.description ? `${idBase}-${index}-description` : undefined}
            onClick={() => select(option.value)}
          >
            <span className="bp-choice-radio" />
            <span>
              <b id={`${idBase}-${index}-title`}>{option.title}</b>
              {option.description ? <small id={`${idBase}-${index}-description`}>{option.description}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
