// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence } from "motion/react";
import { useId, useRef } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { commands } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { MotionListItem } from "../../motion/MotionListItem";
import { showToast } from "../../shell/layers";
import { overviewResource } from "../../stores/projects";
import { failureReason } from "./copy";
import { useLeavingRowFocus } from "./leaving-focus";
import { shownPath, useDisplayPath } from "../shared/display-path";
import { folderName } from "./paths";
import { SectionHeading } from "./SectionHeading";

const FOCUS_PREFIX = "ignored:";

function IgnoredRow({ path, onUnignore, onFocusCapture }: { path: string; onUnignore: () => void; onFocusCapture: () => void }) {
  const pathId = useId();
  // A no-break space holds the line while Rust masks the path, so the row never grows.
  const shown = useDisplayPath(path) ?? "\u00a0";
  return (
    <MotionListItem className="bp-row" data-row-key={path} onFocusCapture={onFocusCapture}>
      <Icon name="folder" className="projects-row-icon" />
      <span id={pathId} className="bp-row-text projects-mono">
        {shown}
      </span>
      <Button size="sm" data-focus-key={FOCUS_PREFIX + path} aria-describedby={pathId} onClick={onUnignore}>
        Un-ignore
      </Button>
    </MotionListItem>
  );
}

interface IgnoredPanelProps {
  paths: readonly string[];
  onLeave: (path: string) => void;
}

export function IgnoredPanel({ paths, onLeave }: IgnoredPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusFromLeavingRow = useLeavingRowFocus(paths, FOCUS_PREFIX, headingRef);

  const unignore = async (path: string) => {
    const [masked, result] = await Promise.all([shownPath(path), callDaemon(() => commands.projectUnignore(path))]);
    const shown = masked ?? folderName(path);
    if (!result.ok) {
      showToast(`Couldn’t un-ignore ${shown}. ${failureReason(result.error)}`, { tone: "error" });
      return;
    }
    onLeave(path);
    overviewResource.invalidate();
    showToast(`${shown} is no longer ignored.`);
  };

  return (
    <section>
      <SectionHeading title="Ignored folders" headingRef={headingRef} />
      <ul className="bp-group projects-list" aria-label="Ignored folders">
        <AnimatePresence initial={false}>
          {paths.map((path) => (
            <IgnoredRow key={path} path={path} onUnignore={() => void unignore(path)} onFocusCapture={() => focusFromLeavingRow(path)} />
          ))}
        </AnimatePresence>
      </ul>
      {paths.length === 0 ? <p className="bp-help">No ignored folders.</p> : null}
      <p className="bp-help">Ignored folders are never suggested again. Un-ignore one to see it under Found.</p>
    </section>
  );
}
