// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useEffect, useRef, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";

import { announceBusy, clearBusyAnnouncement, ensureBusyRegion } from "./busy-announcer";

import { Icon, type IconName } from "./Icon";
import { Spinner } from "./Spinner";

type NativeButtonProps = Omit<ComponentPropsWithRef<"button">, "type"> & {
  type?: "button" | "submit" | "reset";
};

export type ButtonVariant = "default" | "primary" | "danger" | "ghost-danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends NativeButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** A leading icon; replaced by a spinner while loading. */
  icon?: IconName;
  /** An icon after the label, e.g. the external-link glyph. */
  trailingIcon?: IconName;
  /** Shows a spinner, sets aria-busy, announces "<label>, working…" politely and swallows presses. */
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "default",
  size = "md",
  block = false,
  icon,
  trailingIcon,
  loading = false,
  type = "button",
  className = "",
  onClick,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wasLoading = useRef(false);
  useEffect(() => {
    ensureBusyRegion();
  }, []);
  useEffect(() => {
    if (loading && !wasLoading.current) announceBusy(buttonRef.current?.textContent ?? "");
    if (!loading && wasLoading.current) clearBusyAnnouncement();
    wasLoading.current = loading;
  }, [loading]);
  return (
    <button
      {...rest}
      ref={mergeRefs(buttonRef, ref)}
      type={type}
      className={`bp-btn ${className}`}
      data-variant={variant}
      data-size={size}
      data-block={block ? "true" : undefined}
      aria-busy={loading ? true : undefined}
      onClick={loading ? undefined : onClick}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
      {trailingIcon ? <Icon name={trailingIcon} /> : null}
    </button>
  );
}

function mergeRefs<T>(own: { current: T | null }, forwarded: Ref<T> | undefined) {
  return (node: T | null) => {
    own.current = node;
    if (typeof forwarded === "function") forwarded(node);
    else if (forwarded) forwarded.current = node;
  };
}

export interface IconButtonProps extends Omit<NativeButtonProps, "children" | "aria-label" | "title"> {
  icon: IconName;
  /** The accessible name; also the tooltip unless `tooltip` is given. */
  label: string;
  tooltip?: string | undefined;
}

export function IconButton({ icon, label, tooltip, type = "button", className = "", ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} className={`bp-icon-btn ${className}`} aria-label={label} title={tooltip ?? label}>
      <Icon name={icon} />
    </button>
  );
}

export interface LinkButtonProps extends NativeButtonProps {
  icon?: IconName;
  iconPosition?: "start" | "end";
}

export function LinkButton({ icon, iconPosition = "end", type = "button", className = "", children, ...rest }: LinkButtonProps) {
  return (
    <button {...rest} type={type} className={`bp-link-btn ${className}`}>
      {icon && iconPosition === "start" ? <Icon name={icon} /> : null}
      {children}
      {icon && iconPosition === "end" ? <Icon name={icon} /> : null}
    </button>
  );
}
