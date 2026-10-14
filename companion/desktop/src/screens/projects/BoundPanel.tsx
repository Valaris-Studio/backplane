// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { AnimatePresence } from "motion/react";
import { useState } from "react";

import { LinkButton } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { PrivacyLevelControl } from "../../components/PrivacyLevelControl";
import { PRIVACY_LEVELS, type PrivacyLevel } from "../../components/privacy-levels";
import { useRichCaptureOffer } from "../../stores/rich-capture";
import { Switch } from "../../components/Switch";
import { commands, type AgentAccess, type DiscoveredProject, type MappingUpdate_Deserialize } from "../../ipc/bindings";
import { callDaemon } from "../../ipc/daemon";
import { MotionListItem } from "../../motion/MotionListItem";
import { showToast } from "../../shell/layers";
import { useAgentAccess } from "../../stores/agent-access";
import { useDeviceConnected } from "../../stores/daemon-hooks";
import { refreshAfterPolicyChange, type ProjectMapping } from "../../stores/projects";
import { AgentAccessNotes, AgentAccessRow } from "./AgentAccessRow";
import { failureReason } from "./copy";
import { useDisplayPath } from "../shared/display-path";
import { folderName } from "./paths";
import { repoName, safeRepo } from "./repo";
import { SectionHeading } from "./SectionHeading";

// The server's default level, for a value this build does not know.
const FALLBACK_LEVEL: PrivacyLevel = "standard";

function privacyLevel(value: string | null | undefined): PrivacyLevel {
  return PRIVACY_LEVELS.find((level) => level === value) ?? FALLBACK_LEVEL;
}

/** `path` is shown masked by display_path; `repo` is shown as it is. */
type FolderLabel = { name: string; path: string } | { name: string; repo: string | null };

/** A folder mapping shows its path; a rootless repo mapping shows the folder it was found in, else the repo. */
function folderLabel(mapping: ProjectMapping, discovered: readonly DiscoveredProject[]): FolderLabel {
  if (mapping.root_path) return { name: folderName(mapping.root_path), path: mapping.root_path };
  const repo = safeRepo(mapping.repo_url_normalized);
  if (!repo) return { name: "Unrecognised repository", repo: null };
  const foundAt = discovered.find((project) => safeRepo(project.repo_url) === repo)?.root;
  return foundAt ? { name: folderName(foundAt), path: foundAt } : { name: repoName(repo), repo };
}

// A no-break space holds the line while Rust masks the path, so the row never grows.
function FolderSub({ label }: { label: FolderLabel }) {
  const shownPath = useDisplayPath("path" in label ? label.path : null);
  if (!("path" in label)) return label.repo ? <small>{label.repo}</small> : null;
  return <small>{shownPath ?? "\u00a0"}</small>;
}

function boardLine(mapping: ProjectMapping): { board: string; workspace: string | null } {
  if (mapping.board_name) return { board: mapping.board_name, workspace: mapping.workspace_name };
  if (!mapping.board_id) return { board: "No board chosen yet", workspace: mapping.workspace_name };
  return { board: "A board you can’t open right now", workspace: mapping.workspace_name };
}

type Pending = Partial<{ enabled: boolean; content_level: PrivacyLevel }>;

interface BoundRowProps {
  mapping: ProjectMapping;
  label: FolderLabel;
  pending: Pending | undefined;
  onChange: (update: Pending) => void;
  /** null while the daemon can't say whether agents are on: no switch is shown then. */
  agentAccess: AgentAccess | null;
  connected: boolean;
}

// Why a rich binding captures as Full here (contract §2, MappingEffectiveCapture).
const RICH_FALLBACK: Record<"device_unsupported" | "server_disabled", string> = {
  device_unsupported: "Captured as Full until Companion is updated.",
  server_disabled: "Captured as Full: rich capture is off on this Backplane.",
};

function BoundRow({ mapping, label, pending, onChange, agentAccess, connected }: BoundRowProps) {
  const richOffer = useRichCaptureOffer();
  const enabled = pending?.enabled ?? mapping.enabled;
  const fallbackReason = mapping.capture?.reason;
  const level = pending?.content_level ?? privacyLevel(mapping.content_level);
  const { board, workspace } = boardLine(mapping);
  return (
    <MotionListItem className="projects-proj" data-enabled={enabled}>
      <div className="projects-proj-head">
        <Icon name="folder" />
        <div className="projects-proj-name">
          <b>{label.name}</b>
          <FolderSub label={label} />
        </div>
        <Switch checked={enabled} label={`Capture sessions in ${label.name}`} onCheckedChange={(checked) => onChange({ enabled: checked })} />
      </div>
      <div className="projects-proj-board">
        <Icon name="arrow" />
        <span>
          <b>{board}</b>
          {workspace ? ` · ${workspace}` : null}
        </span>
      </div>
      <div className="projects-privacy">
        {enabled ? (
          <>
            <PrivacyLevelControl
              label={`What’s sent for ${label.name}`}
              value={level}
              onValueChange={(next) => onChange({ content_level: next })}
              richOffer={richOffer}
            />
            {fallbackReason ? <p className="bp-privacy-help">{RICH_FALLBACK[fallbackReason]}</p> : null}
          </>
        ) : (
          <p className="bp-privacy-help">Off. Sessions in this folder are not captured.</p>
        )}
      </div>
      {agentAccess ? (
        <AgentAccessRow
          mappingId={mapping.id}
          folder={label.name}
          access={agentAccess.mappings.find((candidate) => candidate.mapping_id === mapping.id)}
          warnings={agentAccess.warnings}
          connected={connected}
        />
      ) : null}
    </MotionListItem>
  );
}

type PendingChanges = Readonly<Record<string, Pending>>;

function without(changes: PendingChanges, id: string): PendingChanges {
  return Object.fromEntries(Object.entries(changes).filter(([pendingId]) => pendingId !== id));
}

function unsettled(changes: PendingChanges, mappings: readonly ProjectMapping[]): PendingChanges {
  const kept = Object.entries(changes).filter(([id, change]) => {
    const mapping = mappings.find((candidate) => candidate.id === id);
    if (!mapping) return false;
    const enabledSettled = change.enabled === undefined || change.enabled === mapping.enabled;
    const levelSettled = change.content_level === undefined || change.content_level === mapping.content_level;
    return !(enabledSettled && levelSettled);
  });
  return kept.length === Object.keys(changes).length ? changes : Object.fromEntries(kept);
}

/** A change shows at once and stays until the refreshed policy agrees; a failure puts it back. */
function usePendingChanges(mappings: readonly ProjectMapping[]) {
  const [pending, setPending] = useState<PendingChanges>({});
  const [seenMappings, setSeenMappings] = useState(mappings);
  // Adjusted while rendering when a new policy arrives (React's "derive from props" pattern).
  if (seenMappings !== mappings) {
    setSeenMappings(mappings);
    setPending(unsettled(pending, mappings));
  }

  const apply = async (mapping: ProjectMapping, name: string, change: Pending) => {
    setPending((current) => ({ ...current, [mapping.id]: { ...current[mapping.id], ...change } }));
    const update: MappingUpdate_Deserialize = change;
    const result = await callDaemon(() => commands.mappingUpdate(mapping.id, update));
    if (result.ok) {
      refreshAfterPolicyChange();
      return;
    }
    setPending((current) => without(current, mapping.id));
    showToast(`Couldn’t change ${name}. ${failureReason(result.error)}`, { tone: "error" });
  };

  return { pending, apply };
}

interface BoundPanelProps {
  mappings: readonly ProjectMapping[];
  discovered: readonly DiscoveredProject[];
  onAddFolder: (opener: HTMLElement) => void;
}

export function BoundPanel({ mappings, discovered, onAddFolder }: BoundPanelProps) {
  const { pending, apply } = usePendingChanges(mappings);
  const agentAccess = useAgentAccess();
  const connected = useDeviceConnected() === true;
  return (
    <section>
      <SectionHeading
        title="Captured, and what’s sent"
        action={
          <LinkButton icon="plus" iconPosition="start" onClick={(event) => onAddFolder(event.currentTarget)}>
            Add a folder…
          </LinkButton>
        }
      />
      {agentAccess ? <AgentAccessNotes access={agentAccess} /> : null}
      <ul className="bp-group projects-list" aria-label="Bound folders">
        <AnimatePresence initial={false}>
          {mappings.map((mapping) => {
            const label = folderLabel(mapping, discovered);
            return (
              <BoundRow
                key={mapping.id}
                mapping={mapping}
                label={label}
                pending={pending[mapping.id]}
                onChange={(change) => void apply(mapping, label.name, change)}
                agentAccess={agentAccess}
                connected={connected}
              />
            );
          })}
        </AnimatePresence>
      </ul>
      {mappings.length === 0 ? <p className="bp-help">No folders are bound yet. Bind one under Found, or add a folder.</p> : null}
    </section>
  );
}
