// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test/test-utils";
import { LaunchRunnerWizard } from "../LaunchRunnerWizard";
import { RunnerLaunchPanel } from "../RunnerLaunchPanel";
import { RunnerConfigDialog } from "@/features/git/components/RunnerConfigDialog";
import { RunnerConfigFiles } from "../RunnerConfigFiles";

const state = vi.hoisted(() => ({
  teams: { data: [] as unknown[] | undefined, isPending: false, isError: false, refetch: vi.fn() },
  boards: { data: [] as unknown[] | undefined, isPending: false, isError: false, refetch: vi.fn() },
  config: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
  createTeam: { mutate: vi.fn(), isPending: false },
  addMember: { mutate: vi.fn(), isPending: false },
  agent: { id: "ag1", name: "Sam's runner", raw_api_key: null as string | null },
}));
vi.mock("../../../hooks/useTeams", () => ({ useTeams: () => state.teams, useCreateTeam: () => state.createTeam, useAddTeamMember: () => state.addMember }));
vi.mock("../../../hooks/useWorkspaceConfig", () => ({ useWorkspaceConfig: () => ({}) }));
vi.mock("@/features/kanban/api/use-boards", () => ({ useBoards: () => state.boards }));
vi.mock("@/features/git/api/use-runner-config", () => ({ useRunnerConfig: () => state.config }));
vi.mock("../../../hooks/useAgentMetrics", () => ({ useCreateAgent: () => ({ isPending: false, mutate: (_: unknown, options: { onSuccess: (a: unknown) => void }) => options.onSuccess(state.agent) }) }));

function start(onOpenChange = vi.fn()) {
  const result = renderWithProviders(<LaunchRunnerWizard slug="ws" open onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByTestId("wizard-runner-name"), { target: { value: "runner" } });
  fireEvent.click(screen.getByTestId("wizard-create"));
  return result;
}
function configStep() { start(); fireEvent.click(screen.getByTestId("wizard-skip")); }
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state.teams, { data: [], isPending: false, isError: false });
  Object.assign(state.boards, { data: [{ id: "b1", name: "Board" }], isPending: false, isError: false });
  Object.assign(state.config, { data: { runner_yaml: "", mcp_config_json: "{}", prerequisites: [] }, isLoading: false, isError: false });
  state.createTeam.isPending = false;
  state.addMember.isPending = false;
  state.agent.raw_api_key = null;
});
describe("runner recovery", () => {
  it.each(["pending", "error"])("does not create a team when team discovery is %s", async (status) => {
    Object.assign(state.teams, { data: undefined, isPending: status === "pending", isError: status === "error" });
    start();
    expect(screen.getByTestId("wizard-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(state.createTeam.mutate).not.toHaveBeenCalled();
    if (status === "error") {
      fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
      expect(state.teams.refetch).toHaveBeenCalledOnce();
    }
  });
  it.each(["createTeam", "addMember"] as const)("blocks skipping during %s", (mutation) => {
    state[mutation].isPending = true;
    start();
    expect(screen.getByTestId("wizard-skip")).toBeDisabled();
  });
  it.each(["pending", "error", "empty"])("distinguishes board %s and preserves interactive setup", (status) => {
    Object.assign(state.boards, { data: status === "empty" ? [] : undefined, isPending: status === "pending", isError: status === "error" });
    configStep();
    expect(screen.getByTestId(`wizard-boards-${status}`)).toBeInTheDocument();
    expect(screen.queryByTestId("download-agent-config")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("wizard-launch-command-interactive")).toBeInTheDocument();
  });
  it("retries config discovery", async () => {
    Object.assign(state.config, { data: undefined, isError: true });
    configStep();
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
    expect(state.config.refetch).toHaveBeenCalledOnce();
  });
  it("returns from launch to config recovery without creating another identity", () => {
    configStep();
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-back-config"));
    expect(screen.getByTestId("wizard-step-config")).toBeInTheDocument();
  });
  it("uses the same shell-quoted exported filename for launch and doctor", () => {
    configStep(); fireEvent.click(screen.getByTestId("wizard-next"));
    const path = `'runner-Sam'"'"'s runner.yaml'`;
    expect(screen.getByTestId("wizard-launch-command")).toHaveTextContent(`-config ${path}`);
    expect(screen.getByTestId("wizard-doctor-command")).toHaveTextContent(`-doctor -config ${path}`);
  });
  it("keeps a revealed key on Escape until closing is explicitly confirmed", () => {
    state.agent.raw_api_key = "vlr_once";
    const close = vi.fn(); start(close);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId("wizard-api-key")).toHaveTextContent("vlr_once");
    fireEvent.click(screen.getByTestId("wizard-discard-key"));
    expect(close).toHaveBeenCalledWith(false);
  });
  it("allows retrying an agent bundle failure without hiding available config", async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error("Forbidden")).mockResolvedValueOnce(undefined);
    renderWithProviders(<RunnerConfigFiles data={{ runner_yaml: "", mcp_config_json: "{}", prerequisites: [] }} isLoading={false} isError={false} onDownloadAgentConfig={download} />);
    fireEvent.click(screen.getByTestId("download-agent-config"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/download/i);
    fireEvent.click(screen.getByTestId("download-agent-config"));
    expect(download).toHaveBeenCalledTimes(2);
  });
});


describe("shared runner config consumers", () => {
  it.each(["pending", "error", "empty"])("shows board %s in the existing-runner panel", (status) => {
    Object.assign(state.boards, { data: status === "empty" ? [] : undefined, isPending: status === "pending", isError: status === "error" });
    renderWithProviders(<RunnerLaunchPanel slug="ws" agentId="ag1" agentName="runner" />);
    expect(screen.getByTestId(`launch-boards-${status}`)).toBeInTheDocument();
    expect(screen.queryByTestId("download-agent-config")).not.toBeInTheDocument();
  });
  it("quotes the existing runner's exported path", () => {
    renderWithProviders(<RunnerLaunchPanel slug="ws" agentId="ag1" agentName="Sam's runner" />);
    expect(screen.getByTestId("launch-command")).toHaveTextContent(`-config 'runner-Sam'"'"'s runner.yaml'`);
  });
  it.each(["panel", "dialog"])("retries config from the %s", async (consumer) => {
    Object.assign(state.config, { data: undefined, isError: true });
    renderWithProviders(consumer === "panel" ? <RunnerLaunchPanel slug="ws" agentId="ag1" agentName="runner" /> : <RunnerConfigDialog slug="ws" boardId="b1" open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /retry/i }));
    expect(state.config.refetch).toHaveBeenCalledOnce();
  });
});
