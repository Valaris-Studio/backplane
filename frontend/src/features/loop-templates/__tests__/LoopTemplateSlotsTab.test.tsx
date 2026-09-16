// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import { LoopTemplateSlotsTab } from "../components/LoopTemplateSlotsTab";
import { TemplateSaveStatus } from "../components/TemplateSaveStatus";
import { TemplateDraftProvider } from "../hooks/TemplateDraftProvider";

// Card 2c18790f (F6) — the draft store now consults the caller's workspace
// role, so a tab test has to declare one. Admin: every case below asserts the
// editable behaviour, and an unmocked role lookup resolves to NOT-admin.
// dnd-kit's DndContext is mocked at the module boundary so a drop can be
// driven as data. jsdom reports a zero rect for every element, and BOTH of
// dnd-kit's sensors resolve their target by comparing measured rects, so no
// real gesture — pointer or keyboard — can ever complete in this environment.
// The provider itself is what is replaced; `useSortable` and SortableContext
// stay real, so the rows still register and render exactly as they ship.
let dragEnd: ((event: unknown) => void) | null = null;
vi.mock("@dnd-kit/core", async () => {
  const actual =
    await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (event: unknown) => void;
    }) => {
      dragEnd = onDragEnd;
      return children;
    },
  };
});

const adminState = { current: { role: "admin" as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));


// Card a62cd831 — spec §5.1 Slots tab, the SlotSpec catalog editor.
//
// Two contracts are load-bearing here and each is pinned below:
//   1. The UI's slot grammar and kind vocabulary EQUAL the backend's
//      (SLOT_NAME_PATTERN, SlotKind in app/services/loop_template_render.py).
//      A row this tab writes must be one the publish validator accepts.
//   2. `used_in` is DERIVED, never authored: the column is recomputed from the
//      draft prompts + variant fills, which is also what makes the
//      remove-guard's reference count trustworthy.

const SLUG = "acme";
const REF = "11111111-2222-3333-4444-555555555555";
const DETAIL_URL = `/api/workspaces/${SLUG}/loop-templates/${REF}`;

let patches: Record<string, unknown>[];

function detail(over: Record<string, unknown> = {}) {
  return {
    id: REF,
    slug: "coding-loop",
    source: "workspace",
    name: "Coding Loop",
    version: 2,
    is_system: false,
    is_draft: false,
    profile: {},
    content: { system_prompt: "", loop_prompt: "", slots: [] },
    lineage: null,
    updated_at: "2026-08-17T00:00:00Z",
    draft_updated_at: "2026-08-17T00:00:00Z",
    has_unpublished_changes: false,
    ...over,
  };
}

function serve(detailBody: Record<string, unknown>) {
  server.use(
    http.get(DETAIL_URL, () => HttpResponse.json(detailBody)),
    http.patch(DETAIL_URL, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return HttpResponse.json({ ...detailBody, ...body });
    }),
  );
}

function renderTab() {
  return renderWithProviders(
    <TemplateDraftProvider slug={SLUG} templateRef={REF}>
      {/* The save-status pill is the draft store's `dirty` flag made
          observable. A tab case that needs to prove an interaction did NOT
          touch the draft cannot use the PATCH count for it: autosave is
          debounced, so an unwritten draft and a not-yet-written one look
          identical for the first 800ms. */}
      <TemplateSaveStatus />
      <LoopTemplateSlotsTab slug={SLUG} templateRef={REF} />
    </TemplateDraftProvider>,
  );
}

/** The row element for a slot, once the tab has loaded. */
async function row(name: string) {
  return await screen.findByTestId(`loop-template-slot-row-${name}`);
}

/**
 * Open a row's disclosure (card 3ac481c5).
 *
 * The detail half — label/help/example/default and the kind editors — is
 * UNMOUNTED while the row is collapsed, so any case that touches those fields
 * has to expand the row first. Idempotent by design: it no-ops if the row is
 * already open, so a case can call it without tracking prior state.
 */
async function expand(name: string) {
  const toggle = within(await row(name)).getByTestId(
    `loop-template-slot-disclosure-${name}`,
  );
  if (toggle.getAttribute("aria-expanded") !== "true") {
    await userEvent.click(toggle);
  }
  return within(await row(name));
}

/** The tab's own onDragEnd, as the mocked provider last received it. */
function capturedDragEnd() {
  if (!dragEnd) throw new Error("DndContext never rendered");
  return dragEnd;
}

beforeEach(() => {
  adminState.current.role = "admin";
  patches = [];
  dragEnd = null;
});

describe("LoopTemplateSlotsTab — name validation (AC1)", () => {
  it("rejects a lowercase name with a field error and does not write the draft", async () => {
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "<<RUN_LABEL>>",
          slots: [{ name: "RUN_LABEL", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const nameInput = within(await row("RUN_LABEL")).getByTestId(
      "loop-template-slot-name",
    );
    await user.clear(nameInput);
    await user.type(nameInput, "runlabel");

    expect(
      await screen.findByTestId("loop-template-slot-error-0"),
    ).toHaveTextContent(/[A-Z]/);
    // An invalid name must never reach the draft: the backend would 422 the
    // whole content bag, losing edits made on other tabs.
    await waitFor(() => expect(patches).toHaveLength(0));
  });

  it("rejects a leading digit", async () => {
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "<<RUN_LABEL>>",
          slots: [{ name: "RUN_LABEL", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const nameInput = within(await row("RUN_LABEL")).getByTestId(
      "loop-template-slot-name",
    );
    await user.clear(nameInput);
    await user.type(nameInput, "1ABC");

    expect(
      await screen.findByTestId("loop-template-slot-error-0"),
    ).toBeInTheDocument();
    await waitFor(() => expect(patches).toHaveLength(0));
  });

  it("rejects a duplicate of another catalogued slot", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>> <<BETA>>",
          loop_prompt: "",
          slots: [
            { name: "ALPHA", kind: "scalar" },
            { name: "BETA", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const nameInput = within(await row("BETA")).getByTestId(
      "loop-template-slot-name",
    );
    await user.clear(nameInput);
    await user.type(nameInput, "ALPHA");

    // Typing is per-keystroke, so the prefixes ("A", "AL", …) are legitimate
    // names and DO commit — only the final "ALPHA" collides. What must never
    // happen is the collision reaching the draft: the two rows would then
    // carry the same name and publish would reject the pair.
    expect(
      await screen.findByTestId("loop-template-slot-error-1"),
    ).toBeInTheDocument();
    expect(nameInput).toHaveValue("ALPHA");
    await waitFor(() =>
      expect(
        (
          patches[patches.length - 1]?.content as {
            slots: { name: string }[];
          }
        ).slots.map((slot) => slot.name),
      ).toEqual(["ALPHA", "ALPH"]),
    );
  });

  it("accepts a valid rename and writes it through the draft", async () => {
    serve(
      detail({
        content: {
          system_prompt: "",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const nameInput = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-name",
    );
    await user.clear(nameInput);
    await user.type(nameInput, "GAMMA_2");

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]?.content as {
      slots: { name: string }[];
    };
    expect(last.slots[0]?.name).toBe("GAMMA_2");
  });
});

describe("LoopTemplateSlotsTab — kind vocabulary (AC1)", () => {
  it("offers exactly the backend SlotKind values", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    renderTab();

    const kind = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-kind",
    );
    const offered = within(kind)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    // Mirrors SlotKind in app/services/loop_template_render.py. "text" is NOT
    // a backend kind — a row carrying it fails the publish validator.
    expect(offered).toEqual(["scalar", "block", "enum", "variant", "list"]);
  });

  it("adds a new row with a backend-valid default kind", async () => {
    serve(
      detail({ content: { system_prompt: "", loop_prompt: "", slots: [] } }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByTestId("loop-template-slot-add"));
    const nameInput = within(await row("NEW_SLOT")).getByTestId(
      "loop-template-slot-name",
    );
    expect(nameInput).toBeInTheDocument();

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]?.content as {
      slots: { kind: string }[];
    };
    expect(last.slots[0]?.kind).toBe("scalar");
  });

  it("swaps in the enum editor when the kind changes to enum", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("ALPHA");

    expect(
      within(await row("ALPHA")).queryByTestId(
        "loop-template-slot-enum-values",
      ),
    ).toBeNull();

    await user.selectOptions(
      within(await row("ALPHA")).getByTestId("loop-template-slot-kind"),
      "enum",
    );

    expect(
      await within(await row("ALPHA")).findByTestId(
        "loop-template-slot-enum-values",
      ),
    ).toBeInTheDocument();
  });

  it("swaps in the list editor (item kind + join) when the kind changes to list", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("ALPHA");

    await user.selectOptions(
      within(await row("ALPHA")).getByTestId("loop-template-slot-kind"),
      "list",
    );

    const alpha = await row("ALPHA");
    expect(
      await within(alpha).findByTestId("loop-template-slot-item-kind"),
    ).toBeInTheDocument();
    expect(
      within(alpha).getByTestId("loop-template-slot-join"),
    ).toBeInTheDocument();
  });
});

describe("LoopTemplateSlotsTab — non-string defaults (AC6)", () => {
  it("renders a list slot's array default as one line per item", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<KEYS>>",
          loop_prompt: "",
          slots: [
            {
              name: "KEYS",
              kind: "list",
              join: ", ",
              default: ["north_star", "guiding_principles"],
            },
          ],
        },
      }),
    );
    renderTab();

    const field = (await expand("KEYS")).getByTestId(
      "loop-template-slot-default",
    );
    // Items show separated by the escaped literal `\n`, matching the join
    // field beside them: a one-line input cannot hold a raw newline.
    // Blanking it was the bug: the author could not see the default they had
    // authored, and the next keystroke on the row overwrote it.
    expect(field).toHaveValue("north_star\\nguiding_principles");
  });

  it("keeps an array default intact when another field on the row is edited", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<KEYS>>",
          loop_prompt: "",
          slots: [
            {
              name: "KEYS",
              kind: "list",
              join: ", ",
              default: ["north_star", "guiding_principles"],
            },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.type(
      (await expand("KEYS")).getByTestId("loop-template-slot-label"),
      "K",
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]!;
    const slots = (last.content as Record<string, unknown>).slots as Record<
      string,
      unknown
    >[];
    expect(slots[0]!.default).toEqual(["north_star", "guiding_principles"]);
  });

  it("writes an edited list default back as an array, one item per line", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<KEYS>>",
          loop_prompt: "",
          slots: [{ name: "KEYS", kind: "list", join: ", ", default: [] }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.type(
      (await expand("KEYS")).getByTestId("loop-template-slot-default"),
      "north_star",
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]!;
    const slots = (last.content as Record<string, unknown>).slots as Record<
      string,
      unknown
    >[];
    expect(slots[0]!.default).toEqual(["north_star"]);
  });


  // D2: the separator is the two-character escape `\n`, so an item that
  // legitimately CONTAINS a backslash-n — a Windows path, a regex — was torn
  // in two on the way to the editor and never came back whole. The escape has
  // to escape itself before it can serve as a separator.
  it("round-trips a list item that contains a literal backslash-n", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<KEYS>>",
          loop_prompt: "",
          slots: [
            {
              name: "KEYS",
              kind: "list",
              join: ", ",
              default: ["C:\\new", "b"],
            },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const field = (await expand("KEYS")).getByTestId(
      "loop-template-slot-default",
    );
    // The item's own backslash shows doubled, which is what tells the escape
    // apart from the separator that follows it.
    expect(field).toHaveValue("C:\\\\new\\nb");

    // A no-op edit (type then delete) must hand the array back unchanged.
    await user.type(field, "x{Backspace}");
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]!;
    const slots = (last.content as Record<string, unknown>).slots as Record<
      string,
      unknown
    >[];
    expect(slots[0]!.default).toEqual(["C:\\new", "b"]);
  });
  it("leaves a scalar slot's string default a string", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar", default: "plain" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const field = (await expand("ALPHA")).getByTestId(
      "loop-template-slot-default",
    );
    expect(field).toHaveValue("plain");
    await user.type(field, "!");

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]!;
    const slots = (last.content as Record<string, unknown>).slots as Record<
      string,
      unknown
    >[];
    expect(slots[0]!.default).toBe("plain!");
  });
});

describe("LoopTemplateSlotsTab — used-in derivation (AC2)", () => {
  it("reports the prompt fields that reference the slot", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "<<ALPHA>> and <<BETA>>",
          slots: [
            { name: "ALPHA", kind: "scalar" },
            { name: "BETA", kind: "scalar" },
            { name: "GAMMA", kind: "scalar" },
          ],
        },
      }),
    );
    renderTab();

    expect(
      within(await row("ALPHA")).getByTestId("loop-template-slot-used-in"),
    ).toHaveTextContent("system_prompt");
    expect(
      within(await row("ALPHA")).getByTestId("loop-template-slot-used-in"),
    ).toHaveTextContent("loop_prompt");
    // BETA is referenced by the loop prompt ONLY — a used-in that reported
    // both fields for every referenced slot would pass a single-field check.
    const beta = within(await row("BETA")).getByTestId(
      "loop-template-slot-used-in",
    );
    expect(beta).toHaveTextContent("loop_prompt");
    expect(beta).not.toHaveTextContent("system_prompt");
  });

  it("warns that an unreferenced slot is unused", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [
            { name: "ALPHA", kind: "scalar" },
            { name: "GAMMA", kind: "scalar" },
          ],
        },
      }),
    );
    renderTab();

    expect(
      await screen.findByTestId("loop-template-slot-unused-GAMMA"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("loop-template-slot-unused-ALPHA")).toBeNull();
  });

  it("counts a variant fill as a reference, so a fill-only slot is not unused", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [
                { id: "fast", label: "Fast", fills: { BODY: "<<GAMMA>>" } },
              ],
            },
            { name: "GAMMA", kind: "scalar" },
          ],
        },
      }),
    );
    renderTab();

    await row("GAMMA");
    expect(screen.queryByTestId("loop-template-slot-unused-GAMMA")).toBeNull();
  });
});

describe("LoopTemplateSlotsTab — remove guard (AC2)", () => {
  it("blocks removing a referenced slot and names the reference count", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "<<ALPHA>> <<ALPHA>>",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    const remove = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-remove",
    );
    expect(remove).toBeDisabled();
    // 3 occurrences across both prompts — the count is what tells the author
    // how much editing stands between them and a safe delete.
    expect(
      within(await row("ALPHA")).getByTestId(
        "loop-template-slot-remove-blocked",
      ),
    ).toHaveTextContent("3");

    await user.click(remove);
    await waitFor(() => expect(patches).toHaveLength(0));
  });

  it("removes an unreferenced slot through the draft", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [
            { name: "ALPHA", kind: "scalar" },
            { name: "GAMMA", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(
      within(await row("GAMMA")).getByTestId("loop-template-slot-remove"),
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]?.content as {
      slots: { name: string }[];
    };
    expect(last.slots.map((slot) => slot.name)).toEqual(["ALPHA"]);
  });
});

describe("LoopTemplateSlotsTab — variant editor (AC3)", () => {
  it("limits a fill target to catalogued slots and writes the fill", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>> <<BODY>>",
          loop_prompt: "",
          slots: [
            { name: "MODE", kind: "variant", variants: [] },
            { name: "BODY", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    await user.click(
      within(await row("MODE")).getByTestId("loop-template-variant-add"),
    );

    // Card d73aa054: fill testids gained a per-ROW suffix when the editor
    // stopped truncating `fills` to its first entry. Row 0 of preset 0.
    const target = await screen.findByTestId(
      "loop-template-variant-fill-slot-0-0",
    );
    const offered = within(target)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    // Only catalogued slots, and never the variant slot itself — a variant
    // that fills itself is a render cycle.
    expect(offered).toEqual(["BODY"]);
  });

  it("renders rails.loop_landing as a select over the two backend values", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [{ id: "fast", label: "Fast", fills: {}, rails: {} }],
            },
          ],
        },
      }),
    );
    renderTab();
    await expand("MODE");

    const landing = await screen.findByTestId(
      "loop-template-variant-landing-0",
    );
    const offered = within(landing)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    // _LOOP_LANDINGS in app/services/loop_config_validation.py. `self_merge`
    // was added to the backend enum by card cda74af9 (B9) but never reached
    // this select's source list, so the shipped coding-loop template's own
    // preset rail was unselectable here until card d73aa054.
    expect(offered).toEqual(["human", "merge_queue", "self_merge"]);
  });

  it("edits tools_extra through the shared ToolPicker", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [
                {
                  id: "fast",
                  label: "Fast",
                  fills: {},
                  tools_extra: ["Read"],
                },
              ],
            },
          ],
        },
      }),
    );
    renderTab();
    await expand("MODE");

    const picker = await screen.findByTestId("loop-template-variant-tools-0");
    // "Read" appears twice inside the picker — once in the browsable catalog
    // and once as a SELECTED chip. Only the second proves tools_extra was
    // handed through, so the assertion counts rather than merely finding one.
    expect(within(picker).getAllByText("Read")).toHaveLength(2);
  });
});

// Card d73aa054 (F5) — presets: the editor must round-trip the WHOLE `fills`
// map. Loop #8 shipped a single-entry editor (`Object.entries(fills)[0]`) that
// silently dropped entries 2..n on the next autosave, so every case below
// loads a MULTI-entry map and asserts what reaches the PATCH body, never what
// the DOM merely displays.
describe("LoopTemplateSlotsTab — preset fills round-trip (card d73aa054)", () => {
  function threeFills(over: Record<string, unknown> = {}) {
    return detail({
      content: {
        system_prompt: "<<MODE>> <<A>> <<B>> <<C>>",
        loop_prompt: "",
        slots: [
          {
            name: "MODE",
            kind: "variant",
            variants: [
              {
                id: "fast",
                label: "Fast",
                fills: { A: "1", B: "2", C: "3" },
                tools_extra: [],
                rails: {},
              },
            ],
          },
          { name: "A", kind: "scalar" },
          { name: "B", kind: "scalar" },
          { name: "C", kind: "scalar" },
        ],
      },
      ...over,
    });
  }

  /** The `fills` map of preset `presetIndex` in the newest autosave body. */
  function lastFills(slotIndex = 0, presetIndex = 0) {
    const content = patches[patches.length - 1]?.content as {
      slots: { variants?: { fills: Record<string, string> }[] }[];
    };
    return content.slots[slotIndex]?.variants?.[presetIndex]?.fills;
  }

  it("renders one row per fill entry, not just the first", async () => {
    serve(threeFills());
    renderTab();
    await expand("MODE");

    await screen.findByTestId("loop-template-variant-fill-slot-0-0");
    const targets = screen
      .getAllByTestId(/^loop-template-variant-fill-slot-0-\d+$/)
      .map((select) => (select as HTMLSelectElement).value);
    expect(targets).toEqual(["A", "B", "C"]);

    const values = screen
      .getAllByTestId(/^loop-template-variant-fill-value-0-\d+$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(values).toEqual(["1", "2", "3"]);
  });

  it("editing the SECOND fill's value leaves A and C intact on the wire", async () => {
    serve(threeFills());
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    await user.type(
      await screen.findByTestId("loop-template-variant-fill-value-0-1"),
      "9",
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    // Key ORDER matters as much as membership: slotRowPropsEqual deep-compares
    // the slot through JSON.stringify, so a reordering write would defeat the
    // 58-row memo boundary even while the values stayed correct.
    expect(Object.entries(lastFills()!)).toEqual([
      ["A", "1"],
      ["B", "29"],
      ["C", "3"],
    ]);
  });

  it("retargeting a fill MOVES the value in place, without cloning or dropping siblings", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>> <<A>> <<B>> <<C>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [
                {
                  id: "fast",
                  label: "Fast",
                  fills: { A: "1", B: "2" },
                  tools_extra: [],
                  rails: {},
                },
              ],
            },
            { name: "A", kind: "scalar" },
            { name: "B", kind: "scalar" },
            { name: "C", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    await user.selectOptions(
      await screen.findByTestId("loop-template-variant-fill-slot-0-1"),
      "C",
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(Object.entries(lastFills()!)).toEqual([
      ["A", "1"],
      ["C", "2"],
    ]);
  });

  it("never offers a slot another fill of the same preset already targets", async () => {
    serve(threeFills());
    renderTab();
    await expand("MODE");

    const target = await screen.findByTestId(
      "loop-template-variant-fill-slot-0-0",
    );
    const offered = within(target)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    // B and C are taken by the sibling rows; the owning slot MODE is never a
    // target. Two fills on one key cannot survive a JSON object, so the picker
    // has to prevent it rather than let the map silently collapse.
    expect(offered).toEqual(["A"]);
  });

  it("adds an empty fill row and removes exactly the row asked for", async () => {
    serve(threeFills());
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    await user.click(
      await screen.findByTestId("loop-template-variant-fill-add-0"),
    );
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    // An un-targeted row is held in the map under the empty key so it survives
    // the round-trip until the operator picks a slot for it.
    expect(Object.entries(lastFills()!)).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
      ["", ""],
    ]);

    await user.click(screen.getByTestId("loop-template-variant-fill-remove-0-1"));
    await waitFor(() =>
      expect(Object.keys(lastFills()!)).toEqual(["A", "C", ""]),
    );
  });

  // D1: `fills` is a JSON object and an un-targeted row lives under the EMPTY
  // key, so a second blank row would collapse onto the first and the click
  // would do nothing at all — no row, no error, no PATCH. The picker already
  // stops two rows colliding on a real slot name; the empty key is the one
  // collision it could not express, so the button closes the gap instead.
  it("blocks Add fill while a row is still untargeted, and says why", async () => {
    // Only A and B are filled, so the row opened below still has C to aim at —
    // threeFills leaves no free target and the retarget half would be vacuous.
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>> <<A>> <<B>> <<C>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [
                {
                  id: "fast",
                  label: "Fast",
                  fills: { A: "1", B: "2" },
                  tools_extra: [],
                  rails: {},
                },
              ],
            },
            { name: "A", kind: "scalar" },
            { name: "B", kind: "scalar" },
            { name: "C", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    const add = await screen.findByTestId("loop-template-variant-fill-add-0");
    await user.click(add);
    await waitFor(() =>
      expect(
        screen.getAllByTestId(/^loop-template-variant-fill-slot-0-\d+$/),
      ).toHaveLength(3),
    );

    // The second click must not be a silent no-op: the button is out of
    // service and carries the reason an operator can act on.
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(/pick a target slot/i);
    await user.click(add);
    expect(
      screen.getAllByTestId(/^loop-template-variant-fill-slot-0-\d+$/),
    ).toHaveLength(3);

    // Targeting the open row frees the button again.
    await user.selectOptions(
      screen.getByTestId("loop-template-variant-fill-slot-0-2"),
      "C",
    );
    await waitFor(() => expect(add).toBeEnabled());
  });

  it("empties the map when the last fill is removed, and still saves the preset", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>> <<A>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [
                {
                  id: "fast",
                  label: "Fast",
                  fills: { A: "1" },
                  tools_extra: [],
                  rails: {},
                },
              ],
            },
            { name: "A", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    await user.click(
      await screen.findByTestId("loop-template-variant-fill-remove-0-0"),
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const content = patches[patches.length - 1]?.content as {
      slots: { variants?: { id: string; fills: Record<string, string> }[] }[];
    };
    expect(content.slots[0]?.variants?.[0]?.fills).toEqual({});
    expect(content.slots[0]?.variants?.[0]?.id).toBe("fast");
  });

  it("summarises what choosing the preset does, and recounts as it changes", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>> <<A>> <<B>> <<C>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [
                {
                  id: "fast",
                  label: "Fast",
                  fills: { A: "1", B: "2" },
                  tools_extra: ["Read", "Edit"],
                  rails: { loop_landing: "human", max_iterations: 30 },
                },
              ],
            },
            { name: "A", kind: "scalar" },
            { name: "B", kind: "scalar" },
            { name: "C", kind: "scalar" },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    const effects = await screen.findByTestId(
      "loop-template-variant-effects-0",
    );
    // The rails bag carries more than loop_landing, so the count is over the
    // WHOLE bag — a summary that only knew about landing would read "1 rail".
    expect(effects).toHaveTextContent("2 fills");
    expect(effects).toHaveTextContent("+2 tools");
    expect(effects).toHaveTextContent("2 rails");

    await user.click(screen.getByTestId("loop-template-variant-fill-add-0"));
    await waitFor(() => expect(effects).toHaveTextContent("3 fills"));
  });

  it("explains what a preset does, including who wins on a conflict", async () => {
    serve(threeFills());
    renderTab();
    await expand("MODE");

    // The precedence half is the load-bearing one: an operator who does not
    // know a typed value beats the preset's fill will read a filled slot as
    // un-overridable. resolve_variants in loop_template_render.py is the rule
    // this sentence mirrors.
    const explainer = await screen.findByText(/wins over the preset's fill/i);
    expect(explainer).toBeInTheDocument();
  });

  it("says Preset in the UI while the wire value stays `variant`", async () => {
    serve(threeFills());
    const user = userEvent.setup();
    renderTab();
    await expand("MODE");

    const kind = within(await row("MODE")).getByTestId(
      "loop-template-slot-kind",
    );
    // Both halves of the copy-only rename in one assertion: the operator reads
    // "Preset", the publish validator still receives "variant".
    expect(
      (
        within(kind).getByRole("option", { name: /preset/i }) as
          HTMLOptionElement
      ).value,
    ).toBe("variant");

    await user.type(
      await screen.findByTestId("loop-template-variant-fill-value-0-0"),
      "0",
    );
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const content = patches[patches.length - 1]?.content as {
      slots: { kind: string; variants?: unknown[] }[];
    };
    expect(content.slots[0]?.kind).toBe("variant");
    expect(content.slots[0]?.variants).toHaveLength(1);
  });

  it("offers every backend landing on a preset rail, self_merge included", async () => {
    serve(threeFills());
    renderTab();
    await expand("MODE");

    const landing = await screen.findByTestId(
      "loop-template-variant-landing-0",
    );
    const offered = within(landing)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    // _LOOP_LANDINGS in app/services/loop_config_validation.py. The shipped
    // coding-loop template sets self_merge on a preset rail, so a select that
    // cannot offer it renders the seed's own value unselectable.
    expect(offered).toEqual(["human", "merge_queue", "self_merge"]);
  });
});

describe("LoopTemplateSlotsTab — system templates are read-only (AC4)", () => {
  it("disables every control but still shows the values", async () => {
    serve(
      detail({
        is_system: true,
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [
            {
              name: "ALPHA",
              kind: "enum",
              required: true,
              help: "which mode",
              enum_values: ["a", "b"],
            },
          ],
        },
      }),
    );
    renderTab();
    // A read-only row still DISCLOSES: the operator must be able to read the
    // help text even though nothing on the row is editable.
    await expand("ALPHA");

    const alpha = await row("ALPHA");
    expect(within(alpha).getByTestId("loop-template-slot-name")).toBeDisabled();
    expect(within(alpha).getByTestId("loop-template-slot-kind")).toBeDisabled();
    expect(
      within(alpha).getByTestId("loop-template-slot-remove"),
    ).toBeDisabled();
    // Values stay legible — read-only is not hidden.
    expect(within(alpha).getByTestId("loop-template-slot-name")).toHaveValue(
      "ALPHA",
    );
    expect(within(alpha).getByTestId("loop-template-slot-help")).toHaveValue(
      "which mode",
    );
    expect(screen.queryByTestId("loop-template-slot-add")).toBeNull();
  });
});

describe("LoopTemplateSlotsTab — scale (AC5)", () => {
  it("renders a 58-row catalog and re-renders only the edited row", async () => {
    const slots = Array.from({ length: 58 }, (_, index) => ({
      name: `SLOT_${index}`,
      kind: "scalar",
    }));
    serve(
      detail({
        content: {
          system_prompt: slots.map((slot) => `<<${slot.name}>>`).join(" "),
          loop_prompt: "",
          slots,
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await row("SLOT_57");
    expect(screen.getAllByTestId(/^loop-template-slot-row-/)).toHaveLength(58);

    await expand("SLOT_0");
    // Measured AFTER the expand, so this asserts the KEYSTROKE boundary the
    // test is named for and not the separately guarded disclosure boundary.
    const before = Number(
      (await row("SLOT_57")).getAttribute("data-render-count"),
    );
    await user.type(
      within(await row("SLOT_0")).getByTestId("loop-template-slot-help"),
      "x",
    );

    // The memo boundary is the point: typing in row 0 must not re-render the
    // other 57 rows, or a 58-slot catalog drops keystrokes.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("loop-template-slot-row-SLOT_0")).getByTestId(
          "loop-template-slot-help",
        ),
      ).toHaveValue("x"),
    );
    expect(
      Number((await row("SLOT_57")).getAttribute("data-render-count")),
    ).toBe(before);
  });
});

// Card 2c18790f (F6) — AC6, for the read-only reason that did not exist when
// the AC4 block above was written. A MEMBER's rows must degrade exactly like a
// system template's: every control disabled, every VALUE still legible.
describe("LoopTemplateSlotsTab — non-admins are read-only (card 2c18790f)", () => {
  it("disables every control but still shows the values for a MEMBER", async () => {
    adminState.current.role = "member";
    serve(
      detail({
        // Deliberately NOT a system template: this is the case the old
        // is_system-only predicate rendered fully editable.
        is_system: false,
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [
            {
              name: "ALPHA",
              kind: "enum",
              required: true,
              help: "which mode",
              enum_values: ["a", "b"],
            },
          ],
        },
      }),
    );
    renderTab();
    // A read-only row still DISCLOSES: the operator must be able to read the
    // help text even though nothing on the row is editable.
    await expand("ALPHA");

    const alpha = await row("ALPHA");
    expect(within(alpha).getByTestId("loop-template-slot-name")).toBeDisabled();
    expect(within(alpha).getByTestId("loop-template-slot-kind")).toBeDisabled();
    expect(
      within(alpha).getByTestId("loop-template-slot-remove"),
    ).toBeDisabled();

    // Disabled, NOT hidden — the member still needs to read the template they
    // are about to bind a board to.
    expect(within(alpha).getByTestId("loop-template-slot-name")).toHaveValue(
      "ALPHA",
    );
    expect(within(alpha).getByTestId("loop-template-slot-help")).toHaveValue(
      "which mode",
    );
    expect(screen.queryByTestId("loop-template-slot-add")).toBeNull();
  });

  it("issues no PATCH when a MEMBER types into a slot field", async () => {
    adminState.current.role = "member";
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "string", required: false, help: "" }],
        },
      }),
    );
    renderTab();
    await expand("ALPHA");

    const alpha = await row("ALPHA");
    const help = within(alpha).getByTestId("loop-template-slot-help");
    await userEvent.type(help, "nope");

    expect(help).toHaveValue("");
    expect(patches).toHaveLength(0);
  });
});

// Card 3ac481c5 (F8) — the row is a DISCLOSURE, not a wall of fields.
//
// 58 slots × 8 always-open controls is what the operator actually scrolls
// today. Collapsing the detail half behind a per-row toggle is only worth
// anything if it keeps the memo boundary intact (expanding row 0 must not
// re-render row 57), so the render-count guard below is the acceptance signal
// for the whole redesign, not a formality.
describe("LoopTemplateSlotsTab — row disclosure (card 3ac481c5)", () => {
  function twoSlots() {
    return detail({
      content: {
        system_prompt: "<<ALPHA>> <<BETA>>",
        loop_prompt: "",
        slots: [
          { name: "ALPHA", kind: "scalar", help: "the alpha help" },
          { name: "BETA", kind: "scalar", help: "the beta help" },
        ],
      },
    });
  }

  it("keeps label/help/example/default out of the DOM until the row is expanded", async () => {
    serve(twoSlots());
    renderTab();

    const alpha = within(await row("ALPHA"));
    // The identity half stays visible — this is what makes 58 rows scannable.
    expect(alpha.getByTestId("loop-template-slot-name")).toBeInTheDocument();
    expect(alpha.getByTestId("loop-template-slot-kind")).toBeInTheDocument();
    // The detail half is ABSENT, not merely hidden: a `hidden` subtree still
    // costs 58 rows' worth of inputs to mount and still answers queries.
    expect(alpha.queryByTestId("loop-template-slot-label")).toBeNull();
    expect(alpha.queryByTestId("loop-template-slot-help")).toBeNull();
    expect(alpha.queryByTestId("loop-template-slot-example")).toBeNull();
    expect(alpha.queryByTestId("loop-template-slot-default")).toBeNull();
  });

  it("keeps the kind editors collapsed too — they are the heaviest half", async () => {
    // enum/list/preset editors are whole sub-forms. Leaving one of the three
    // outside the disclosure would quietly undo the redesign for every row of
    // that kind, and the label/help/example/default check above cannot see it.
    serve(
      detail({
        content: {
          system_prompt: "<<MODE>> <<KEYS>> <<PICK>>",
          loop_prompt: "",
          slots: [
            {
              name: "MODE",
              kind: "variant",
              variants: [{ id: "fast", label: "Fast", fills: {}, rails: {} }],
            },
            { name: "KEYS", kind: "list", join: ", ", default: [] },
            { name: "PICK", kind: "enum", enum_values: ["a", "b"] },
          ],
        },
      }),
    );
    renderTab();

    expect(
      within(await row("MODE")).queryByTestId(
        "loop-template-slot-tooltip-variant",
      ),
    ).toBeNull();
    expect(screen.queryByTestId("loop-template-variant-add")).toBeNull();
    expect(
      within(await row("KEYS")).queryByTestId("loop-template-slot-item-kind"),
    ).toBeNull();
    expect(
      within(await row("PICK")).queryByTestId("loop-template-slot-enum-values"),
    ).toBeNull();

    // …and each one is reachable the moment its own row opens.
    expect(
      (await expand("PICK")).getByTestId("loop-template-slot-enum-values"),
    ).toBeInTheDocument();
  });

  it("reveals the detail fields when the disclosure is opened, and hides them again", async () => {
    serve(twoSlots());
    const user = userEvent.setup();
    renderTab();

    const toggle = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-disclosure-ALPHA",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const opened = within(await row("ALPHA"));
    expect(opened.getByTestId("loop-template-slot-help")).toHaveValue(
      "the alpha help",
    );

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(await row("ALPHA")).queryByTestId("loop-template-slot-help"),
    ).toBeNull();
  });

  it("expansion is row-local: opening one row leaves its sibling collapsed", async () => {
    serve(twoSlots());
    const user = userEvent.setup();
    renderTab();

    await user.click(
      within(await row("ALPHA")).getByTestId(
        "loop-template-slot-disclosure-ALPHA",
      ),
    );

    expect(
      within(await row("ALPHA")).getByTestId("loop-template-slot-help"),
    ).toBeInTheDocument();
    expect(
      within(await row("BETA")).queryByTestId("loop-template-slot-help"),
    ).toBeNull();
    expect(
      within(await row("BETA")).getByTestId(
        "loop-template-slot-disclosure-BETA",
      ),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("expanding a row in a 58-slot catalog does not re-render the other 57", async () => {
    const slots = Array.from({ length: 58 }, (_, index) => ({
      name: `SLOT_${index}`,
      kind: "scalar",
      help: `help ${index}`,
    }));
    serve(
      detail({
        content: { system_prompt: "<<SLOT_0>>", loop_prompt: "", slots },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByTestId("loop-template-slot-row-SLOT_57")).toBeTruthy();
    const before = Number(
      (await row("SLOT_57")).getAttribute("data-render-count"),
    );

    await user.click(
      within(await row("SLOT_0")).getByTestId(
        "loop-template-slot-disclosure-SLOT_0",
      ),
    );
    // The opened row obviously re-rendered; the point is that its 57 siblings
    // did not. Expansion state living in the ROW is what buys that — lifting
    // it into the tab would re-render the whole list on every toggle.
    expect(
      within(await row("SLOT_0")).getByTestId("loop-template-slot-help"),
    ).toBeInTheDocument();
    expect(
      Number((await row("SLOT_57")).getAttribute("data-render-count")),
    ).toBe(before);
  });

  it("a name error stays visible across a collapse, because pendingNames lives in the tab", async () => {
    serve(twoSlots());
    const user = userEvent.setup();
    renderTab();

    const toggle = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-disclosure-ALPHA",
    );
    await user.click(toggle);
    const nameInput = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-name",
    );
    await user.clear(nameInput);
    await user.type(nameInput, "lower");
    expect(
      await within(await row("ALPHA")).findByTestId(
        "loop-template-slot-error-0",
      ),
    ).toBeInTheDocument();

    // Collapsing hides the DETAIL fields; the name and its error are identity.
    await user.click(toggle);
    expect(
      within(await row("ALPHA")).getByTestId("loop-template-slot-error-0"),
    ).toBeInTheDocument();
  });
});

/**
 * jsdom's stand-in for a textarea's content height.
 *
 * jsdom has no layout engine, so the real `scrollHeight` is a hard 0 and the
 * hook would measure nothing. The important half is the CLAMP: a real browser
 * never reports a scrollHeight smaller than the height already applied to the
 * element, which is precisely why the hook must reset `height` to `auto`
 * before it measures. A stub that ignored the applied height would report the
 * right answer either way and make that reset untestable.
 */
function stubScrollHeight(element: HTMLTextAreaElement, lineHeight = 24) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get() {
      const content = lineHeight * (String(element.value).split("\n").length || 1);
      const applied = Number.parseFloat(element.style.height);
      return Number.isFinite(applied) ? Math.max(content, applied) : content;
    },
  });
}

describe("LoopTemplateSlotsTab — auto-growing long-value fields (card 3ac481c5)", () => {
  it("grows the help textarea's inline height to fit its content", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar", help: "" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(
      within(await row("ALPHA")).getByTestId(
        "loop-template-slot-disclosure-ALPHA",
      ),
    );
    const help = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-help",
    ) as HTMLTextAreaElement;

    stubScrollHeight(help);

    await user.type(help, "one{Enter}two{Enter}three");

    // The STYLE PROPERTY, not an aria attribute: this is the pixel the fix
    // manipulates, and the only thing that would look different in a browser.
    expect(help.style.height).toBe("72px");
    expect(help.tagName).toBe("TEXTAREA");
  });

  it("shrinks back when the content does, instead of latching at the tallest", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar", help: "" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(
      within(await row("ALPHA")).getByTestId(
        "loop-template-slot-disclosure-ALPHA",
      ),
    );
    const help = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-help",
    ) as HTMLTextAreaElement;
    stubScrollHeight(help);

    await user.type(help, "one{Enter}two{Enter}three");
    expect(help.style.height).toBe("72px");

    await user.clear(help);
    await user.type(help, "one");
    // Resetting to `auto` before measuring is what makes this possible; without
    // it scrollHeight can never report less than the height already set.
    expect(help.style.height).toBe("24px");
  });
});

describe("LoopTemplateSlotsTab — honest kind labels (card 3ac481c5)", () => {
  it("labels the kinds in prose while the option VALUES stay the backend enum", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    renderTab();

    const kind = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-kind",
    );
    const options = within(kind).getAllByRole("option") as HTMLOptionElement[];
    const byValue = Object.fromEntries(
      options.map((option) => [option.value, option.textContent?.trim()]),
    );

    // The only behaviour that separates scalar from block is that the backend
    // rejects a newline in a scalar (scalar_must_be_single_line), so THAT is
    // what the label should say — not the wire identifier.
    expect(byValue.scalar).toBe("Single line");
    expect(byValue.block).toBe("Multi-line text");
    // The wire vocabulary is untouched; renaming a VALUE would fail publish.
    expect(options.map((option) => option.value)).toEqual([
      "scalar",
      "block",
      "enum",
      "variant",
      "list",
    ]);
    // …and no label is still a bare identifier the operator has to decode.
    expect(Object.values(byValue)).not.toContain("scalar");
    expect(Object.values(byValue)).not.toContain("block");
  });

  it("still writes `kind: \"block\"` on the wire when the prose label is chosen", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.selectOptions(
      within(await row("ALPHA")).getByTestId("loop-template-slot-kind"),
      "block",
    );

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const last = patches[patches.length - 1]?.content as {
      slots: { kind: string }[];
    };
    expect(last.slots[0]?.kind).toBe("block");
  });
});

describe("LoopTemplateSlotsTab — RichTooltips on the slot fields (card 3ac481c5)", () => {
  it("wires every identity control to its ui.tooltips.loopTemplates.slots.* key", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    renderTab();

    const alpha = within(await row("ALPHA"));
    // `data-tooltip-key` is the same assertable wiring the Rails tab uses:
    // the panel itself needs a hover jsdom's layout engine cannot drive.
    for (const field of ["name", "kind", "required", "autofill"]) {
      expect(
        alpha
          .getByTestId(`loop-template-slot-tooltip-${field}`)
          .getAttribute("data-tooltip-key"),
      ).toBe(`loopTemplates.slots.${field}`);
    }
  });

  it("wires the default field's tooltip once the row is expanded", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [{ name: "ALPHA", kind: "scalar" }],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(
      within(await row("ALPHA")).getByTestId(
        "loop-template-slot-disclosure-ALPHA",
      ),
    );
    expect(
      within(await row("ALPHA"))
        .getByTestId("loop-template-slot-tooltip-default")
        .getAttribute("data-tooltip-key"),
    ).toBe("loopTemplates.slots.default");
  });

  it("wires the preset editor's tooltip on a variant row", async () => {
    serve(
      detail({
        content: {
          system_prompt: "<<ALPHA>>",
          loop_prompt: "",
          slots: [
            { name: "ALPHA", kind: "variant", variants: [] },
          ],
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();

    await user.click(
      within(await row("ALPHA")).getByTestId(
        "loop-template-slot-disclosure-ALPHA",
      ),
    );
    expect(
      within(await row("ALPHA"))
        .getByTestId("loop-template-slot-tooltip-variant")
        .getAttribute("data-tooltip-key"),
    ).toBe("loopTemplates.slots.variant");
  });
});

// Card 7f7eb6a7 (F10) — slot ORDER is authored, not accidental.
//
// The order a row sits in here is the order TemplateBindStep asks the board
// operator to fill the slot in, so it is a product decision the author must be
// able to make.
//
// Every case below drives the up/down BUTTONS, not a drag. That is not a
// testing convenience — it is the affordance under test. dnd-kit resolves both
// its pointer gesture AND its keyboard sensor by comparing measured element
// rects (`sortableKeyboardCoordinates` filters droppable containers by their
// `droppableRects` entries), and jsdom reports every rect as zeroes, so no
// candidate is ever found and no drag of either kind can complete here. The
// buttons move a row by ±1 without consulting geometry at all, which is also
// what makes reorder reachable without a mouse. The drag path shares their one
// write function (`moveSlotBy`), so what these cases pin is the persisted
// result of both.
describe("LoopTemplateSlotsTab — slot reorder (card 7f7eb6a7)", () => {
  /** The three-slot catalog every reorder case starts from. */
  function threeSlots() {
    return [
      { name: "ALPHA", kind: "scalar", help: "first" },
      { name: "BRAVO", kind: "scalar", help: "second" },
      { name: "CHARLIE", kind: "scalar", help: "third" },
    ];
  }

  function serveThree(over: Record<string, unknown> = {}) {
    serve(
      detail({
        ...over,
        content: {
          system_prompt: "<<ALPHA>> <<BRAVO>> <<CHARLIE>>",
          loop_prompt: "",
          slots: threeSlots(),
        },
      }),
    );
  }

  /** The rendered order, top to bottom, as slot names. */
  function renderedOrder() {
    return screen
      .getAllByTestId(/^loop-template-slot-row-/)
      .map((node) => node.getAttribute("data-testid")!.replace(
        "loop-template-slot-row-",
        "",
      ));
  }

  /** Move a row with the keyboard-reachable buttons, one position per press. */
  async function moveBy(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
    direction: "up" | "down",
    times = 1,
  ) {
    for (let step = 0; step < times; step += 1) {
      await user.click(
        within(await row(name)).getByTestId(
          `loop-template-slot-move-${direction}-${name}`,
        ),
      );
    }
  }

  it("writes one PATCH per move, carrying the new order (AC1, AC2)", async () => {
    serveThree();
    const user = userEvent.setup();
    renderTab();
    await row("CHARLIE");

    await moveBy(user, "CHARLIE", "up");
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(
      (patches[0]!.content as { slots: { name: string }[] }).slots.map(
        (slot) => slot.name,
      ),
    ).toEqual(["ALPHA", "CHARLIE", "BRAVO"]);
    expect(renderedOrder()).toEqual(["ALPHA", "CHARLIE", "BRAVO"]);

    await moveBy(user, "CHARLIE", "up");
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(
      (patches[1]!.content as { slots: { name: string }[] }).slots.map(
        (slot) => slot.name,
      ),
    ).toEqual(["CHARLIE", "ALPHA", "BRAVO"]);
    expect(renderedOrder()).toEqual(["CHARLIE", "ALPHA", "BRAVO"]);
  });

  it("carries each slot's whole object through the move, unchanged (AC7)", async () => {
    serveThree();
    const user = userEvent.setup();
    renderTab();
    await row("ALPHA");

    await moveBy(user, "ALPHA", "down");

    await waitFor(() => expect(patches).toHaveLength(1));
    const moved = (patches[0]!.content as { slots: Record<string, unknown>[] })
      .slots;
    const before = threeSlots();
    // A permutation, not a rewrite: the reorder must not normalize, default or
    // drop a field the author set, because the PATCH replaces the whole bag.
    expect([...moved].sort((a, b) => String(a.name).localeCompare(String(b.name))))
      .toEqual(
        [...before].sort((a, b) => a.name.localeCompare(b.name)).map((slot) =>
          expect.objectContaining(slot),
        ),
      );
    expect(moved.map((slot) => slot.name)).toEqual([
      "BRAVO",
      "ALPHA",
      "CHARLIE",
    ]);
  });

  it("offers no move off either end (AC3)", async () => {
    serveThree();
    renderTab();
    await row("ALPHA");

    // Disabled, not hidden — the control stays where the eye expects it, and
    // being disabled is what keeps `moveSlotBy` in range: the write path
    // deliberately carries no bounds check of its own, so this IS the bound.
    expect(
      within(await row("ALPHA")).getByTestId("loop-template-slot-move-up-ALPHA"),
    ).toBeDisabled();
    expect(
      within(await row("CHARLIE")).getByTestId(
        "loop-template-slot-move-down-CHARLIE",
      ),
    ).toBeDisabled();
    // The interior row can go both ways.
    expect(
      within(await row("BRAVO")).getByTestId("loop-template-slot-move-up-BRAVO"),
    ).toBeEnabled();
    expect(
      within(await row("BRAVO")).getByTestId(
        "loop-template-slot-move-down-BRAVO",
      ),
    ).toBeEnabled();
    expect(patches).toHaveLength(0);
  });

  it("leaves the draft clean when a drag lands where it was lifted", async () => {
    serveThree();
    renderTab();
    await row("BRAVO");
    expect(screen.getByTestId("loop-template-save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );

    // The drag path's no-op case, which the buttons cannot express: dnd-kit
    // reports a drop whose `over` is the row that was lifted. Invoking the
    // DndContext's onDragEnd directly is what reaches it — jsdom gives every
    // row a zero rect, so no real gesture of either kind can complete here.
    // Inside `act`: the handler sets state, and without it React has not
    // committed by the time the assertion reads the DOM — which would make the
    // case pass no matter what the handler did.
    await act(async () => {
      capturedDragEnd()({ active: { id: "BRAVO" }, over: { id: "BRAVO" } });
    });

    // `dirty`, not the PATCH count: the write is debounced, so counting
    // requests cannot tell "never written" from "not written yet" — a guard
    // deleted here would still read as zero patches. Dirtying the draft is the
    // real damage, because it re-arms the unsaved-work guard on the way out.
    expect(screen.getByTestId("loop-template-save-status")).toHaveAttribute(
      "data-state",
      "saved",
    );
    expect(renderedOrder()).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
    expect(patches).toHaveLength(0);
  });

  it("persists the order a real drop resolves to", async () => {
    serveThree();
    renderTab();
    await row("CHARLIE");

    // The same seam, driven with a target that DOES differ — so the case above
    // is pinning the guard rather than a handler that never writes at all.
    await act(async () => {
      capturedDragEnd()({ active: { id: "CHARLIE" }, over: { id: "ALPHA" } });
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(
      (patches[0]!.content as { slots: { name: string }[] }).slots.map(
        (slot) => slot.name,
      ),
    ).toEqual(["CHARLIE", "ALPHA", "BRAVO"]);
  });

  it("keeps an in-progress invalid name on the row it was typed into (AC7)", async () => {
    serveThree();
    const user = userEvent.setup();
    renderTab();
    await row("ALPHA");

    // `pendingNames` is keyed by INDEX, so a move that does not re-key it
    // would slide a half-typed name onto whichever slot lands at that index.
    const nameField = within(await row("ALPHA")).getByTestId(
      "loop-template-slot-name",
    );
    await user.clear(nameField);
    await user.type(nameField, "bad");
    expect(nameField).toHaveValue("bad");

    await moveBy(user, "CHARLIE", "up", 2);
    await waitFor(() => expect(renderedOrder()).toEqual([
      "CHARLIE",
      "ALPHA",
      "BRAVO",
    ]));

    // ALPHA is now at index 1. Its pending name must have travelled with it —
    // and BRAVO, now at index 2, must show its own committed name.
    expect(
      within(await row("ALPHA")).getByTestId("loop-template-slot-name"),
    ).toHaveValue("bad");
    expect(
      within(await row("BRAVO")).getByTestId("loop-template-slot-name"),
    ).toHaveValue("BRAVO");
  });

  it("offers no reorder affordance at all to a read-only member (AC3)", async () => {
    adminState.current.role = "member";
    serveThree({ is_system: false });
    renderTab();
    await row("ALPHA");

    expect(screen.queryByTestId("loop-template-slot-drag-BRAVO")).toBeNull();
    expect(screen.queryByTestId("loop-template-slot-move-up-BRAVO")).toBeNull();
    expect(
      screen.queryByTestId("loop-template-slot-move-down-BRAVO"),
    ).toBeNull();
    expect(patches).toHaveLength(0);
  });

  it("keeps the 58-row memo boundary intact while sortable (AC6)", async () => {
    const slots = Array.from({ length: 58 }, (_, index) => ({
      name: `SLOT_${index}`,
      kind: "scalar",
    }));
    serve(
      detail({
        content: {
          system_prompt: slots.map((slot) => `<<${slot.name}>>`).join(" "),
          loop_prompt: "",
          slots,
        },
      }),
    );
    const user = userEvent.setup();
    renderTab();
    await row("SLOT_57");

    await expand("SLOT_0");
    const before = Number(
      (await row("SLOT_30")).getAttribute("data-render-count"),
    );
    // Making the list sortable put a dnd-kit CONTEXT above every row. Reading
    // it from inside the memoized row would re-render all 58 on every context
    // change — including every keystroke, via the `items` array's identity.
    // The subscription lives in the unmemoized wrapper instead, so this is the
    // same keystroke guard as the AC5 case, re-asserted with sortable wired up.
    await user.type(
      within(await row("SLOT_0")).getByTestId("loop-template-slot-help"),
      "x",
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId("loop-template-slot-row-SLOT_0")).getByTestId(
          "loop-template-slot-help",
        ),
      ).toHaveValue("x"),
    );

    expect(
      Number((await row("SLOT_30")).getAttribute("data-render-count")),
    ).toBe(before);
  });
});
