// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { createContext, use, useId, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "./Icon";

export type FieldTone = "neutral" | "error" | "ok";

interface FieldWiring {
  inputId: string;
  messageId: string | undefined;
  invalid: boolean;
  onEscape: (() => void) | undefined;
}

const FieldContext = createContext<FieldWiring | null>(null);

interface FieldProps {
  label: string;
  /** Hides the label visually; it still names the input. */
  labelHidden?: boolean;
  message?: ReactNode;
  tone?: FieldTone;
  children: ReactNode;
  className?: string;
  /** Passed to its Input: see the Escape rule on Input. */
  onEscape?: () => void;
}

/** Labels its Input and wires the message as its description; tone "error" marks the input invalid. */
export function Field({ label, labelHidden = false, message, tone = "neutral", children, className = "", onEscape }: FieldProps) {
  const inputId = useId();
  const messageId = useId();
  const hasMessage = message !== undefined && message !== null && message !== "";
  const wiring: FieldWiring = { inputId, messageId: hasMessage ? messageId : undefined, invalid: tone === "error", onEscape };

  return (
    <div className={className}>
      <label htmlFor={inputId} className={labelHidden ? "sr-only" : "bp-field-label"}>
        {label}
      </label>
      <FieldContext value={wiring}>{children}</FieldContext>
      {hasMessage ? (
        <p id={messageId} className="bp-field-msg" data-field-message data-tone={tone}>
          {tone === "error" ? <Icon name="alert" /> : tone === "ok" ? <Icon name="check" /> : null}
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}

type InputProps = ComponentPropsWithRef<"input"> & {
  invalid?: boolean;
  /**
   * The Escape rule: an input that gives Escape a meaning (cancel a rename,
   * clear a search) handles it here, and the event is marked defaultPrevented
   * so the sheet, dialog and shell around it (pop, close) leave it alone.
   * Without onEscape, Escape bubbles and closes whatever layer is on top.
   */
  onEscape?: () => void;
};

export function Input({ invalid, className = "", type = "text", onEscape, onKeyDown, ...rest }: InputProps) {
  const field = use(FieldContext);
  const isInvalid = invalid ?? field?.invalid ?? false;
  const handleEscape = onEscape ?? field?.onEscape;
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.key === "Escape" && handleEscape && !event.defaultPrevented) {
      event.preventDefault();
      handleEscape();
    }
  };
  return (
    <input
      id={field?.inputId}
      aria-describedby={field?.messageId}
      autoComplete="off"
      spellCheck={false}
      {...rest}
      type={type}
      aria-invalid={isInvalid}
      className={`bp-input ${className}`}
      onKeyDown={keyDown}
    />
  );
}
