// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, ImportantNote, ProTip, WhatThisIsNot } from "../callouts";

export function GettingStartedCapturingSessionsWithCompanion() {
  return (
    <SectionPage title="Capturing Sessions with Companion" eyebrow="Getting Started">
      <p>
        Backplane Companion is a small background app for the computer where
        your coding agents run. It captures Claude Code, Codex (CLI and
        desktop app) and Pi sessions, uploads them to Backplane, and links each
        session to the cards and notes it touched. Captured sessions appear
        under My sessions and are visible only to you.
      </p>

      <h2 id="server">Check that this Backplane accepts sessions</h2>
      <p>
        The My sessions entry appears in the sidebar only when the server
        accepts Companion sessions. Self-hosted operators turn this on with
        COMPANION_ENABLED, and the Rich content level additionally needs
        RICH_CAPTURE_ENABLED. Both default to false; see Environment
        Variables.
      </p>

      <h2 id="install">Install Companion</h2>
      <p>
        The packaged desktop app is available for macOS 13 or later, as one
        universal build for Apple silicon and Intel, Developer ID signed and
        notarized. The current preview is 0.1.1-preview.2. Download it from
        the My sessions page, or directly:
      </p>
      <CodeExample language="text" title="macOS download">
        {`https://storage.googleapis.com/backplane-artifacts/companion-desktop/v0.1.1-preview.2/Backplane-Companion-0.1.1-preview.2-universal.dmg`}
      </CodeExample>
      <p>
        Open the DMG, move Backplane Companion into Applications, then open it.
        On Linux and Windows the desktop app is a source build for now: the
        companion directory of the public repository documents the toolchain
        and the package builders.
      </p>
      <CodeExample language="text" title="Companion source">
        {`https://github.com/Valaris-Studio/backplane/tree/main/companion`}
      </CodeExample>

      <h2 id="sign-in">Sign in and approve the device</h2>
      <p>
        Open Companion, enter this Backplane&apos;s address, and it shows a
        short pairing code. Choose Open Backplane, sign in if asked, enter the
        code and approve the device. Approve only a request you just started
        on your own computer. The computer then appears under My sessions, in
        the Devices tab. Nothing is captured until a device is approved.
      </p>

      <h2 id="folders">Choose what gets captured</h2>
      <p>
        Companion captures only folders you bind to a workspace, optionally linked
        to a board. Add a folder in
        Companion, or let it bind repositories automatically when their origin
        matches a repository already connected to one of your boards. Folders
        that match neither are listed as discovered projects and nothing from
        them is kept.
      </p>
      <p>
        Each folder has a content level. Metadata sends activity only:
        timing, tokens, cost, and tool and model names. Standard adds your
        prompts, commands and tool arguments. Full adds tool output, agent
        replies and diffs. Rich, where the server offers it, adds messages and
        supported attachments from the agent&apos;s own session files. The
        Devices tab shows exactly what each level sends.
      </p>
      <ImportantNote title="A new level applies to what is captured next">
        Raising or lowering a level never rewrites sessions already sent. The
        server applies the same rules again and never stores more than the
        level allows.
      </ImportantNote>

      <h2 id="first-session">See your first session</h2>
      <p>
        Run Claude Code, Codex or Pi inside a captured folder. The session
        appears under My sessions while it runs, with its timeline, cost and
        the work it linked to. Cards and notes the session touched show it in
        their own linked sessions panel, to you only.
      </p>

      <h2 id="privacy">Privacy and control</h2>
      <p>
        Sessions are private to their owner. Sharing a selected excerpt with a
        card is an explicit action and does not share the raw session. From
        the Devices tab you can pause capture, change a folder&apos;s level,
        rename or sign out a device, and delete everything a device sent.
      </p>
      <WhatThisIsNot title="Companion is not a runner">
        A runner claims and executes cards on its own. Companion only records
        the sessions you run yourself; it never starts an agent, claims a card
        or changes a repository.
      </WhatThisIsNot>

      <ProTip title="Updates">
        The preview is published on the beta update channel. Installing it
        does not change the channel you chose; select beta in Companion&apos;s
        update settings to receive future previews.
      </ProTip>
    </SectionPage>
  );
}
