# Setup Contract — MCP board-provisioning guide

The **setup contract** is the machine-readable answer to *"what does a board need
to run this pipeline?"* It is an optional, auto-derivable field of a workspace's
`pipeline_config`:

```jsonc
{
  "stages": [ /* ... pipeline stages ... */ ],
  "scheduling": { /* ... */ },
  "setup_contract": {
    "version": 1,
    "columns": [ /* ColumnSpec */ ],
    "labels": [ /* LabelGate */ ],
    "role_orchestration": [ /* RoleOrchestration */ ],
    "prose_overview": "PIPELINE OVERVIEW (all roles) ..."
  }
}
```

A setup agent (human or MCP) reads it to (1) create the right columns in the
right order, (2) understand the label vocabulary and which role owns each label,
and (3) read the role handoff sequence. It is **derived from the live config**
(`build_setup_contract`) so it can never drift from the actual discover /
lifecycle predicates the runner keys on.

The contract is **optional**. A config without one validates fine. When present,
`validate_pipeline_config` runs a drift check: every label / column the config
actually uses must appear in the contract, or the save is rejected with
`setup_contract_label_drift` / `setup_contract_column_drift`. This stops an
operator from shipping a stale onboarding contract after renaming a label.

## Schema

```typescript
interface SetupContract {
  version: 1;

  // Create these columns in this order (left-to-right board layout).
  columns: Array<{
    column_type: "backlog" | "active" | "review" | "done" | "blocked";
    position: number;   // 0-based; canonical board order, NOT scheduler order
    name: string;       // display name, e.g. "Backlog"
  }>;

  // The label vocabulary the pipeline runs on.
  labels: Array<{
    name: string;
    applies_in_role: string | null;   // role whose lifecycle applies it
    removes_in_role: string | null;   // role whose lifecycle removes it
    gated_by_roles: string[];         // roles whose discover filters reference it
    description: string;              // human prose
  }>;

  // Roles in scheduler priority order (the walk order — reviewer-first so a
  // finished card clears before new work is picked up).
  role_orchestration: Array<{
    role: string;
    pick_strategy: string[];   // ["review column", "requires PR url", ...]
    emits: string[];           // ["approve → merges the PR; moves card to done", ...]
    terminal_actions: string[]; // ["moves card to done", "applies label 'planned'"]
  }>;

  prose_overview: string;  // the rendered "PIPELINE OVERVIEW (all roles)" block
}
```

> **Column position vs. role order.** `columns[].position` is the board *layout*
> order (backlog → active → review → done). `role_orchestration` is the
> *scheduler* order (priority_order), which is intentionally different — the
> scheduler walks reviewer-first. Don't conflate the two.

## Board setup flow (MCP agent)

```typescript
async function setupBoardForPipeline(workspaceSlug: string, boardId: string) {
  // 1. Fetch the contract from the workspace config.
  const cfg = await getWorkspaceConfig(workspaceSlug);   // GET /workspaces/{slug}/config
  const contract = cfg.pipeline_config?.setup_contract;
  if (!contract) return; // pipeline ships no contract — nothing to provision.

  // 2. Create columns in layout order.
  for (const col of contract.columns) {
    await createColumn(boardId, {
      name: col.name,
      column_type: col.column_type,
      position: col.position,
    });
  }

  // 3. Drop a label-guide card so humans see the label semantics.
  await createCard(boardId, {
    title: "Label guide (from setup contract)",
    description: contract.labels
      .map((l) => `- **${l.name}** — ${l.description}`)
      .join("\n"),
    column_type: "backlog",
  });

  // 4. (optional) Render the role-orchestration diagram for the board notes.
  const diagram = contract.role_orchestration
    .map((r) => `${r.role}\n  picks: ${r.pick_strategy.join("; ")}\n  emits: ${r.emits[0] ?? "(no decision branches)"}`)
    .join("\n→ ");
  await createNote(boardId, { title: "Pipeline orchestration", body: diagram });
}
```

## Label semantics (default 6-role pipeline)

| label | applied by | removed by | gates | meaning |
|-------|-----------|-----------|-------|---------|
| `planned` | planner | — | planner | plan note written; lets the card leave backlog |
| `planning-failed` | planner | — | — | planner LLM step failed; card needs attention |
| `direct-implement` | (pre-seeded) | — | planner | skip planning; planner excludes the card |
| `needs-ui-validation` | (applied at review) | ui_validator | all build roles + ui_validator | routes a done card to UI validation; build roles skip it |
| `ui-validated` | ui_validator | — | — | UI validation passed; prevents re-validation |
| `rework-mediation-failed` | rework_mediator | — | — | rework_mediator LLM step failed; needs attention |
| `documented` | (pre-seeded / doc flow) | — | documentator | documentator skips already-documented cards |

> `needs-ui-validation` and `direct-implement` have `applies_in_role: null`
> because no *default lifecycle step* applies them — `needs-ui-validation` is
> applied at review time by the live reviewer prompt, and `direct-implement` is
> a human/triage pre-seed. The contract records this faithfully.

## Drift validator

Appended to `validate_pipeline_config`:

- `invalid_setup_contract` — `setup_contract` is present but not a JSON object.
- `setup_contract_label_drift` — a label used in a discover filter or lifecycle
  step is missing from `setup_contract.labels[*].name`.
- `setup_contract_column_drift` — a `discover.column_type` is missing from
  `setup_contract.columns[*].column_type`.

To regenerate a contract from the current config, call `build_setup_contract(config)`
(`app/services/setup_contract.py`) and store its `to_dict()` under
`pipeline_config["setup_contract"]`. The portable config **bundle** (WS2) carries
the contract in its `description` field so an imported pipeline arrives
self-describing.
