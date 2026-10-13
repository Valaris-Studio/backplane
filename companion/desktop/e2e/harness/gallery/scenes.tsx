// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Scenes for the dev-only primitives gallery (see main.tsx).
import { useState, type ReactNode } from "react";

import { AgentTile } from "../../../src/components/AgentTile";
import { AlertDialog } from "../../../src/components/AlertDialog";
import { Banner } from "../../../src/components/Banner";
import { Button, IconButton, LinkButton } from "../../../src/components/Button";
import { Field, Input } from "../../../src/components/Field";
import { Group, Row, RowText, RowValue } from "../../../src/components/Group";
import { AppIcon, Icon, TrayGlyph, type IconName, type TrayGlyphState } from "../../../src/components/Icon";
import { IdleDot, LiveDot } from "../../../src/components/LiveDot";
import { Pill } from "../../../src/components/Pill";
import { PrivacyLevelControl } from "../../../src/components/PrivacyLevelControl";
import type { PrivacyLevel } from "../../../src/components/privacy-levels";
import { SectionHead } from "../../../src/components/SectionHead";
import { Disclosure } from "../../../src/components/Disclosure";
import { Listbox, type ListboxGroup } from "../../../src/components/Listbox";
import { ChoiceGroup, SegmentedControl } from "../../../src/components/SegmentedControl";
import { Select } from "../../../src/components/Select";
import { Quote, StepList } from "../../../src/components/StepList";
import { Stepper } from "../../../src/components/Stepper";
import { Sheet } from "../../../src/components/Sheet";
import { Spinner } from "../../../src/components/Spinner";
import { StatePanel } from "../../../src/components/StatePanel";
import { Switch } from "../../../src/components/Switch";
import { Tabs } from "../../../src/components/Tabs";
import { ToastView } from "../../../src/components/ToastView";

const ICONS: IconName[] = [
  "pause", "play", "gear", "chev-left", "chev-right", "chev-up", "arrow", "external", "copy", "check", "search", "folder",
  "plus", "x", "alert", "info", "refresh", "cloud-off", "shield", "sliders", "power", "download", "terminal", "wrench",
];
const BOARDS: ListboxGroup[] = [
  {
    id: "internal",
    label: "Internal projects",
    options: [
      { value: "b-backplane", label: "Backplane", description: "github.com/valaris/backplane" },
      { value: "b-docs", label: "Docs", description: "No linked repository" },
    ],
  },
  {
    id: "acme",
    label: "Acme",
    options: [
      { value: "b-mobile", label: "Mobile app", description: "github.com/acme/mobile-app", badge: "Linked to this repo" },
      { value: "b-mobile-qa", label: "Mobile app QA", description: "github.com/acme/mobile-app", badge: "Linked to this repo" },
    ],
  },
];

const TRAY_STATES: TrayGlyphState[] = ["capturing", "paused", "attention", "offline", "disconnected"];

function Panel({ children, fixed = false }: { children: ReactNode; fixed?: boolean }) {
  return (
    <main className={`relative w-[360px] overflow-hidden rounded-window bg-material-popover ${fixed ? "h-[540px]" : ""}`}>
      {children}
    </main>
  );
}

export function Primitives() {
  const [tab, setTab] = useState("projects");
  const [subTab, setSubTab] = useState("found");
  const [level, setLevel] = useState<PrivacyLevel>("standard");
  const [fullLevel, setFullLevel] = useState<PrivacyLevel>("full");
  const [server, setServer] = useState("default");
  const [seg, setSeg] = useState("stable");
  const [on, setOn] = useState(true);
  const [advanced, setAdvanced] = useState(true);
  const [off, setOff] = useState(false);

  return (
    <Panel>
      <div className="bp-view gap-0">
        <SectionHead title="Buttons" />
        <div className="bp-btn-row">
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost-danger">Ghost danger</Button>
        </div>
        <div className="bp-btn-row mt-2 items-center">
          <Button size="sm" icon="refresh">Small</Button>
          <Button size="lg" variant="primary">Large</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm" loading>Checking…</Button>
        </div>
        <div className="mt-2">
          <Button block variant="primary">Block</Button>
        </div>
        <div className="bp-btn-row mt-2 items-center">
          <IconButton icon="pause" label="Pause capture" />
          <IconButton icon="gear" label="Settings" />
          <IconButton icon="pause" label="Pause capture" disabled />
          <LinkButton icon="external">Open in Backplane</LinkButton>
          <LinkButton icon="plus" iconPosition="start">Add folder…</LinkButton>
          <Button size="sm" trailingIcon="external">Open Backplane</Button>
        </div>

        <SectionHead title="Tabs" />
        <Tabs
          label="Sections"
          idPrefix="g-tab"
          panelId="g-panel"
          value={tab}
          onValueChange={setTab}
          items={[
            { id: "home", label: "Home" },
            { id: "projects", label: "Projects", count: 5, countLabel: "5 not captured yet" },
            { id: "agents", label: "Agents", dot: true, dotLabel: "needs attention" },
          ]}
        />
        <Tabs
          label="Project lists"
          variant="sub"
          idPrefix="g-sub"
          panelId="g-panel"
          value={subTab}
          onValueChange={setSubTab}
          items={[
            { id: "bound", label: "Bound", count: 3, countLabel: "3 bound" },
            { id: "found", label: "Found", count: 5, countLabel: "5 found" },
            { id: "ignored", label: "Ignored", count: 2, countLabel: "2 ignored" },
            { id: "rules", label: "Rules" },
          ]}
        />

        <SectionHead title="Choices" />
        <SegmentedControl
          label="Channel"
          value={seg}
          onValueChange={setSeg}
          options={[
            { value: "stable", label: "Stable" },
            { value: "beta", label: "Beta" },
          ]}
        />
        <div className="mt-2">
          <PrivacyLevelControl richOffer="offered" value={level} onValueChange={setLevel} />
        </div>
        <div className="mt-2">
          <PrivacyLevelControl richOffer="offered" value={fullLevel} onValueChange={setFullLevel} />
        </div>
        <div className="mt-2">
          <ChoiceGroup
            label="Server"
            value={server}
            onValueChange={setServer}
            options={[
              { value: "default", title: "backplane.example", description: "Backplane hosted by Valaris" },
              { value: "custom", title: "Self-hosted server", description: "Your own Backplane installation" },
            ]}
          />
        </div>

        <SectionHead title="Select, disclosure, steps" />
        <div className="flex items-center gap-3">
          <Select aria-label="Channel" defaultValue="stable">
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </Select>
          <Stepper current={2} total={5} />
        </div>
        <Disclosure open={advanced} onOpenChange={setAdvanced} summary="Advanced: use another server">
          <p className="bp-help">Self-hosted server</p>
        </Disclosure>
        <StepList
          label="Approve Codex hooks"
          steps={[
            <>Open a terminal and start codex.</>,
            <>
              At <Quote>Hooks need review</Quote>, choose <Quote>Trust all and continue</Quote>.
            </>,
          ]}
        />

        <SectionHead title="Group, rows, switches" aside="4 rows" action={<LinkButton icon="external">Open</LinkButton>} />
        <Group label="This Mac">
          <Row>
            <RowText title="Open at login" />
            <Switch label="Open at login" checked={on} onCheckedChange={setOn} />
          </Row>
          <Row>
            <RowText title="Pause capture" sub="Stops recording on this Mac until you turn it back on." />
            <Switch label="Pause capture" checked={off} onCheckedChange={setOff} />
          </Row>
          <Row>
            <RowText title="Disabled" />
            <Switch label="Disabled" checked={false} onCheckedChange={() => {}} disabled />
          </Row>
          <Row>
            <RowText title="Server" />
            <RowValue>backplane.example</RowValue>
          </Row>
        </Group>

        <SectionHead title="Banners" />
        <Banner title="Codex needs your approval" actions={<Button size="sm">Show me how</Button>}>
          Until it is fixed, Codex sessions are not captured.
        </Banner>
        <Banner tone="info" icon="pause" title="Capture is paused" actions={<Button size="sm" variant="primary">Resume</Button>}>
          Sessions you run now are not recorded, not even locally.
        </Banner>
        <Banner tone="error" icon="x" title="The request was declined in Backplane">
          This Mac stays disconnected.
        </Banner>
        <Banner tone="success" icon="download" title="Companion 0.9.0 is ready" />

        <SectionHead title="Pills and agents" />
        <div className="flex flex-wrap items-center gap-2">
          <Pill>Idle</Pill>
          <Pill tone="success">Capturing</Pill>
          <Pill tone="warning">Needs your approval</Pill>
          <Pill tone="error">Needs repair</Pill>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <AgentTile agent="claude_code" />
          <AgentTile agent="codex_cli" />
          <AgentTile agent="pi_cli" />
          <AgentTile agent="gemini" />
          <AgentTile agent="claude_code" size="sm" />
          <LiveDot />
          <IdleDot />
          <Spinner />
        </div>

        <SectionHead title="Fields" />
        <Field label="Device name" message="1 to 80 characters. Press Esc to cancel.">
          <Input defaultValue="Ada’s MacBook Pro" />
        </Field>
        <Field className="mt-2" label="Device name" message="The name can’t be empty." tone="error">
          <Input />
        </Field>
        <Field className="mt-2" label="Server address" message="Found Backplane at this address." tone="ok">
          <Input type="url" defaultValue="https://backplane.northwind.dev" />
        </Field>

        <SectionHead title="Icons" />
        <div className="grid grid-cols-8 gap-2 text-foreground">
          {ICONS.map((name) => (
            <Icon key={name} name={name} size={16} />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-3 text-foreground">
          {TRAY_STATES.map((state) => (
            <TrayGlyph key={state} state={state} className="size-[18px]" />
          ))}
          <AppIcon size={32} />
        </div>

        <StatePanel
          icon="terminal"
          title="No sessions yet"
          actions={<Button>Review projects</Button>}
          finePrint="Sessions appear here within a minute of starting."
        >
          Start Claude Code, Codex or Pi in a bound project.
        </StatePanel>

        <div className="relative mt-2 h-12">
          <div className="bp-toast" data-tone="success" role="status">
            <ToastView message="Capture resumed." />
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function SheetScene() {
  const [level, setLevel] = useState<PrivacyLevel>("standard");
  const [board, setBoard] = useState<string | null>("b-mobile");
  return (
    <Panel fixed>
      <div className="bp-view">
        <SectionHead title="Behind the sheet" />
      </div>
      <Sheet
        title="Bind mobile-app"
        onClose={() => {}}
        footer={
          <>
            <Button>Cancel</Button>
            <Button variant="primary">Bind</Button>
          </>
        }
      >
        <Listbox
          searchLabel="Search boards"
          listLabel="Boards"
          placeholder="Search boards"
          groups={BOARDS}
          value={board}
          onValueChange={setBoard}
          emptyState={(query) => `No boards match “${query}”.`}
        />
        <SectionHead title="What’s sent" />
        <PrivacyLevelControl richOffer="offered" value={level} onValueChange={setLevel} />
      </Sheet>
    </Panel>
  );
}

export function DialogScene() {
  return (
    <Panel fixed>
      <AlertDialog title="Disconnect this Mac?" confirmLabel="Disconnect" onConfirm={() => {}} onCancel={() => {}}>
        <p>Capture stops and this Mac’s sign-in is deleted from the keychain. Agent hooks stay installed but do nothing.</p>
        <p>Sessions already uploaded stay in Backplane.</p>
      </AlertDialog>
    </Panel>
  );
}
