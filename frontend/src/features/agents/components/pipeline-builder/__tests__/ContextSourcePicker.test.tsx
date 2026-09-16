// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ContextSourcePicker } from "../ContextSourcePicker";
import type { ContextSourceEntry } from "../../../api/pipelineConfig";

describe("ContextSourcePicker", () => {
  it("renders the empty hint when value is empty", () => {
    renderWithProviders(<ContextSourcePicker value={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no context sources/i)).toBeInTheDocument();
  });

  it("adds a row with the default kind when 'add source' is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<ContextSourcePicker value={[]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /add context source/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as ContextSourceEntry[];
    expect(next).toHaveLength(1);
    expect(next[0]!.kind).toBe("card_notes");
    expect(next[0]!.as).toBeUndefined();
  });

  it("removes a row when the remove button is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "card_notes" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    await user.click(
      screen.getByRole("button", { name: /remove context source/i }),
    );

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("edits the `as` alias and emits undefined when cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "card_notes" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    const input = screen.getByLabelText(/alias/i);
    await user.type(input, "v");
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "card_notes", as: "v" },
    ]);
  });

  it("emits an undefined alias when the input is cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [
      { kind: "card_notes", as: "verdicts" },
    ];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    const input = screen.getByLabelText(/alias/i) as HTMLInputElement;
    await user.clear(input);

    const lastCall = onChange.mock.calls.at(-1)?.[0] as ContextSourceEntry[];
    expect(lastCall[0]!.as).toBeUndefined();
  });

  it("hides the filter UI for kinds without a filter schema", () => {
    const value: ContextSourceEntry[] = [{ kind: "board_definition" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/\(no filter\)/i)).toBeInTheDocument();
  });

  it("roundtrips card_notes filter.kind through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "card_notes" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    // Radix Select trigger labelled by the filter <label>.
    const trigger = screen.getByLabelText(/filter/i);
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "review_verdict" });
    await user.click(option);

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "card_notes", filter: { kind: "review_verdict" } },
    ]);
  });

  it("clears the filter when switching to a kind without filter schema", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [
      { kind: "card_notes", filter: { kind: "review_verdict" } },
    ];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    const kindTrigger = screen.getByLabelText(/^kind$/i);
    await user.click(kindTrigger);
    const option = await screen.findByRole("option", { name: /board definition/i });
    await user.click(option);

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "board_definition", filter: undefined },
    ]);
  });

  it("hides the filter UI for review_history (no filter schema)", () => {
    const value: ContextSourceEntry[] = [{ kind: "review_history" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/\(no filter\)/i)).toBeInTheDocument();
  });

  it("renders the sibling_cards filter with column type, label, limit", () => {
    const value: ContextSourceEntry[] = [{ kind: "sibling_cards" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    // Sentinel labels from i18n keys we added for siblingCards.
    expect(screen.getByText(/^Column type$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Limit/i)).toBeInTheDocument();
  });

  it("renders the board_snapshot filter with include_done + max_cards", () => {
    const value: ContextSourceEntry[] = [{ kind: "board_snapshot" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/Include Done columns/i)).toBeInTheDocument();
    expect(screen.getByText(/Max cards per column/i)).toBeInTheDocument();
  });

  it("renders the linked_cards filter with direction + limit", () => {
    const value: ContextSourceEntry[] = [{ kind: "linked_cards" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/^Direction$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Limit/i)).toBeInTheDocument();
    expect(screen.queryByText(/\(no filter\)/i)).not.toBeInTheDocument();
  });

  it("roundtrips a linked_cards direction through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "linked_cards" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Any direction/i }));
    const option = await screen.findByRole("option", { name: "depends_on" });
    await user.click(option);

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "linked_cards", filter: { direction: "depends_on" } },
    ]);
  });

  it("renders the execution_history filter with status + limit", () => {
    const value: ContextSourceEntry[] = [{ kind: "execution_history" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/^Status$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Limit/i)).toBeInTheDocument();
    expect(screen.queryByText(/\(no filter\)/i)).not.toBeInTheDocument();
  });

  it("roundtrips an execution_history status through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "execution_history" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Any status/i }));
    const option = await screen.findByRole("option", { name: "completed" });
    await user.click(option);

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "execution_history", filter: { status: "completed" } },
    ]);
  });

  it("renders the card_activity filter with a limit and updates it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "card_activity" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    expect(screen.queryByText(/\(no filter\)/i)).not.toBeInTheDocument();
    const limitInput = screen.getByRole("spinbutton");
    await user.type(limitInput, "5");

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "card_activity", filter: { limit: 5 } },
    ]);
  });

  it("renders the pipeline_expectations filter with a scope select", () => {
    const value: ContextSourceEntry[] = [{ kind: "pipeline_expectations" }];
    renderWithProviders(
      <ContextSourcePicker value={value} onChange={vi.fn()} />,
    );
    expect(screen.getByText(/^Scope$/i)).toBeInTheDocument();
    expect(screen.queryByText(/\(no filter\)/i)).not.toBeInTheDocument();
  });

  it("roundtrips a pipeline_expectations scope through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value: ContextSourceEntry[] = [{ kind: "pipeline_expectations" }];
    renderWithProviders(<ContextSourcePicker value={value} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Current role/i }));
    const option = await screen.findByRole("option", { name: "all_roles" });
    await user.click(option);

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: "pipeline_expectations", filter: { scope: "all_roles" } },
    ]);
  });
});
