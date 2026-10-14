// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { useId, type ReactNode } from "react";

import appTile48 from "../assets/brand/app-tile-48.png";
import appTile96 from "../assets/brand/app-tile-96.png";
import appTile256 from "../assets/brand/app-tile-256.png";

// Transcribed from the DK-0 mockup's <symbol>s. Each glyph carries its own
// stroke/fill attributes (presentation attributes, not style="", for the CSP).
const ROUND = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

const ICON_PATHS = {
  pause: <path d="M9 5v14M15 5v14" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />,
  play: <path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor" />,
  gear: (
    <g fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  "chev-left": <path d="m15 18-6-6 6-6" {...ROUND} strokeWidth={2} />,
  "chev-right": <path d="m9 18 6-6-6-6" {...ROUND} strokeWidth={2} />,
  "chev-up": <path d="m6 15 6-6 6 6" {...ROUND} strokeWidth={2} />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" {...ROUND} strokeWidth={2} />,
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" {...ROUND} strokeWidth={1.9} />,
  copy: (
    <g {...ROUND} strokeWidth={1.8}>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </g>
  ),
  check: <path d="M20 6 9 17l-5-5" {...ROUND} strokeWidth={2.4} />,
  search: (
    <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </g>
  ),
  folder: (
    <path
      d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinejoin="round"
    />
  ),
  plus: <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />,
  x: <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />,
  alert: (
    <g {...ROUND} strokeWidth={1.9}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4M12 17h.01" />
    </g>
  ),
  info: (
    <g fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 16v-4M12 8h.01" />
    </g>
  ),
  refresh: (
    <g {...ROUND} strokeWidth={1.9}>
      <path d="M3 12a9 9 0 0 1 15.74-5.26L21 9" />
      <path d="M21 3v6h-6" />
      <path d="M21 12a9 9 0 0 1-15.74 5.26L3 15" />
      <path d="M3 21v-6h6" />
    </g>
  ),
  "cloud-off": (
    <g {...ROUND} strokeWidth={1.9}>
      <path d="m2 2 20 20" />
      <path d="M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2" />
      <path d="M21.5 16.5A4.5 4.5 0 0 0 17.5 10h-1.8a7 7 0 0 0-6-4.9" />
    </g>
  ),
  shield: (
    <g {...ROUND} strokeWidth={1.8}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </g>
  ),
  sliders: (
    <g fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </g>
  ),
  power: (
    <g fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </g>
  ),
  download: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" {...ROUND} strokeWidth={1.9} />,
  terminal: <path d="m4 17 6-6-6-6M12 19h8" {...ROUND} strokeWidth={2} />,
  dash: <path d="M7 12h10" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />,
  sort: <path d="M7 4v16M3.5 7.5 7 4l3.5 3.5M17 20V4M13.5 16.5 17 20l3.5-3.5" {...ROUND} strokeWidth={2} />,
  wrench: (
    <path
      d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICON_PATHS;

interface IconProps {
  name: IconName;
  className?: string;
  /** Rendered width and height in px; otherwise the parent's CSS sizes it. */
  size?: number;
}

export function Icon({ name, className, size }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon={name} className={className} width={size} height={size}>
      {ICON_PATHS[name]}
    </svg>
  );
}

const PLANE_PATH =
  "M9 1.1C9.9 1.1 10.5 2.1 10.5 3.2V6.9L16.6 10.3V12.2L10.5 10.5V13.6L12.6 15.2V16.7L9 15.8L5.4 16.7V15.2L7.5 13.6V10.5L1.4 12.2V10.3L7.5 6.9V3.2C7.5 2.1 8.1 1.1 9 1.1Z";
const PLANE_TILT = "rotate(45 9 9)";

export type TrayGlyphState = "capturing" | "paused" | "attention" | "offline" | "disconnected";

function Plane({ mask, opacity }: { mask?: string; opacity?: number }) {
  return <path d={PLANE_PATH} fill="currentColor" fillOpacity={opacity} transform={PLANE_TILT} mask={mask} />;
}

/** The menu-bar plane with its state badge; ids are per instance so glyphs can repeat on a page. */
export function TrayGlyph({ state, className }: { state: TrayGlyphState; className?: string }) {
  const maskId = `tray-mask-${useId().replace(/:/g, "")}`;
  const cutoutMask = `url(#${maskId})`;
  const svgProps = { viewBox: "0 0 18 18", "aria-hidden": true, focusable: false, className, "data-tray-glyph": state } as const;

  switch (state) {
    case "capturing":
      return (
        <svg {...svgProps}>
          <Plane />
        </svg>
      );
    case "disconnected":
      return (
        <svg {...svgProps}>
          <Plane opacity={0.42} />
        </svg>
      );
    case "paused":
      return (
        <svg {...svgProps}>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="#fff" />
            <rect x="10.6" y="9.9" width="7.4" height="8.1" rx="1.4" fill="#000" />
          </mask>
          <g mask={cutoutMask}>
            <Plane />
          </g>
          <rect x="11.9" y="11.2" width="1.9" height="5.8" rx="0.6" fill="currentColor" />
          <rect x="15" y="11.2" width="1.9" height="5.8" rx="0.6" fill="currentColor" />
        </svg>
      );
    case "attention":
      return (
        <svg {...svgProps}>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="#fff" />
            <circle cx="13.9" cy="13.9" r="5" fill="#000" />
          </mask>
          <mask id={`${maskId}-bang`} maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="#fff" />
            <rect x="13.2" y="11.1" width="1.4" height="3.4" rx="0.7" fill="#000" />
            <circle cx="13.9" cy="16.1" r="0.85" fill="#000" />
          </mask>
          <g mask={cutoutMask}>
            <Plane />
          </g>
          <circle cx="13.9" cy="13.9" r="3.9" fill="currentColor" mask={`url(#${maskId}-bang)`} />
        </svg>
      );
    case "offline":
      return (
        <svg {...svgProps}>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="18" height="18">
            <rect width="18" height="18" fill="#fff" />
            <circle cx="13.9" cy="13.9" r="5" fill="#000" />
          </mask>
          <g mask={cutoutMask}>
            <Plane />
          </g>
          <circle cx="13.9" cy="13.9" r="3.25" fill="none" stroke="currentColor" strokeWidth={1.3} />
          <path d="M11.6 16.2L16.2 11.6" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
        </svg>
      );
  }
}

/** The Dock icon's tile, generated from brand/source by `pnpm brand:assets`; `size` is the rendered CSS px. */
export function AppIcon({ size, className }: { size: number; className?: string }) {
  return (
    <img
      src={appTile256}
      srcSet={`${appTile48} 48w, ${appTile96} 96w, ${appTile256} 256w`}
      sizes={`${size}px`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={className ? `bp-app-icon ${className}` : "bp-app-icon"}
    />
  );
}
