// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Client-side mirror of backend validator (app/services/pipeline_config_validation.py).
// Returns the same {code, field, message, value?} shape so preview errors match
// what the PATCH will emit. Backend remains the authoritative validator —
// this is a UX fast-path only.

import type {
  ActionDef,
  PipelineConfig,
  PipelineValidationError,
  StageConfig,
} from "../api/pipelineConfig";

const DISCOVER_STRATEGIES = new Set(["unassigned_or_rework", "column_scan"]);
const CLAIM_ROLES = new Set(["hero", "helper"]);
const GIT_ACTIONS = new Set(["create_branch", "checkout_pr_branch", "none", ""]);
const LLM_STAGES = new Set(["implement", "review", "document"]);
const POST_PROCESS_KINDS = new Set([
  "",
  "writes_code",
  "produces_decision",
  "produces_note",
  "mutates_backlog",
]);
const COLUMN_TYPES = new Set(["backlog", "active", "review", "done", ""]);

// Legacy stage names dispatch through specialized engine paths that imply a
// specific kind — an explicit `post_process_kind` that disagrees causes the
// engine's output to be silently discarded.
const LEGACY_STAGE_TO_KIND: Record<string, string> = {
  implement: "writes_code",
  review: "produces_decision",
  document: "writes_code",
};

export function validatePipelineConfig(
  config: PipelineConfig,
  knownSensors: Set<string> | null = null,
): PipelineValidationError[] {
  const errors: PipelineValidationError[] = [];

  if (!config || typeof config !== "object") {
    errors.push({
      code: "invalid_config_shape",
      field: "",
      message: "pipeline_config must be a JSON object",
      params: { field: "" },
    });
    return errors;
  }

  const stages = config.stages;
  if (!Array.isArray(stages)) {
    errors.push({
      code: "missing_stage_key",
      field: "stages",
      message: "pipeline_config.stages must be a list",
      params: { field: "stages" },
    });
    return errors;
  }

  const knownRoles = new Set<string>();
  const seenRoles = new Set<string>();

  stages.forEach((stage, idx) => {
    const path = `stages[${idx}]`;
    if (!stage.role) {
      errors.push({
        code: "missing_stage_key",
        field: `${path}.role`,
        message: `${path}.role must be a non-empty string`,
        params: { field: `${path}.role` },
      });
      return;
    }
    if (seenRoles.has(stage.role)) {
      errors.push({
        code: "duplicate_stage_role",
        field: `${path}.role`,
        message: `duplicate stage role '${stage.role}'`,
        value: stage.role,
        params: { field: `${path}.role`, value: stage.role },
      });
    } else {
      seenRoles.add(stage.role);
      knownRoles.add(stage.role);
    }
  });

  stages.forEach((stage, idx) => {
    const path = `stages[${idx}]`;
    validateDiscover(stage, `${path}.discover`, errors);
    validateClaim(stage, `${path}.claim`, errors);
    validateGit(stage, `${path}.git`, errors);
    validateLLM(stage, `${path}.llm`, errors);
    if (stage.on_success) {
      validateAction(stage.on_success, `${path}.on_success`, knownRoles, errors);
    }
    if (stage.on_failure) {
      validateAction(
        stage.on_failure,
        `${path}.on_failure`,
        knownRoles,
        errors,
      );
    }
    if (knownSensors) {
      validateSensors(stage, `${path}.sensors`, knownSensors, errors);
    }
  });

  const priority = config.scheduling?.priority_order;
  if (Array.isArray(priority)) {
    priority.forEach((role) => {
      if (role && !knownRoles.has(role)) {
        errors.push({
          code: "priority_order_unknown_role",
          field: "scheduling.priority_order",
          message: `scheduling.priority_order references unknown role '${role}'`,
          value: role,
          params: { field: "scheduling.priority_order", value: role },
        });
      }
    });
  }

  return errors;
}

function validateDiscover(
  stage: StageConfig,
  path: string,
  errors: PipelineValidationError[],
): void {
  const strategy = stage.discover?.strategy;
  if (strategy && !DISCOVER_STRATEGIES.has(strategy)) {
    errors.push({
      code: "unknown_discover_strategy",
      field: `${path}.strategy`,
      message: `unknown discover.strategy '${strategy}'`,
      value: strategy,
      params: { field: `${path}.strategy`, value: strategy },
    });
  }
}

function validateClaim(
  stage: StageConfig,
  path: string,
  errors: PipelineValidationError[],
): void {
  const role = stage.claim?.participant_role;
  if (role && !CLAIM_ROLES.has(role)) {
    errors.push({
      code: "unknown_claim_role",
      field: `${path}.participant_role`,
      message: `unknown claim.participant_role '${role}'`,
      value: role,
      params: { field: `${path}.participant_role`, value: role },
    });
  }
}

function validateGit(
  stage: StageConfig,
  path: string,
  errors: PipelineValidationError[],
): void {
  const action = stage.git?.action;
  if (action != null && !GIT_ACTIONS.has(action)) {
    errors.push({
      code: "unknown_git_action",
      field: `${path}.action`,
      message: `unknown git.action '${action}'`,
      value: action,
      params: { field: `${path}.action`, value: action },
    });
  }
}

function validateLLM(
  stage: StageConfig,
  path: string,
  errors: PipelineValidationError[],
): void {
  const llm = stage.llm;
  if (!llm) return;

  const kind = llm.post_process_kind ?? "";
  if (!POST_PROCESS_KINDS.has(kind)) {
    errors.push({
      code: "unknown_post_process_kind",
      field: `${path}.post_process_kind`,
      message: `unknown llm.post_process_kind '${kind}'`,
      value: kind,
      params: { field: `${path}.post_process_kind`, value: kind },
    });
  }

  const hasKind = kind !== "";
  const stageName = llm.stage ?? "";

  if (llm.enabled) {
    if (hasKind) {
      if (!stageName) {
        errors.push({
          code: "unknown_llm_stage",
          field: `${path}.stage`,
          message: "llm.stage must be a non-empty string when llm.enabled=true",
          value: stageName,
          params: { field: `${path}.stage`, value: stageName },
        });
      }
    } else if (!LLM_STAGES.has(stageName)) {
      errors.push({
        code: "unknown_llm_stage",
        field: `${path}.stage`,
        message: `llm.stage '${stageName}' is invalid when llm.enabled=true (expected implement/review/document or set llm.post_process_kind)`,
        value: stageName,
        params: { field: `${path}.stage`, value: stageName },
      });
    }
  }

  if (llm.approval_enabled && stageName !== "implement") {
    errors.push({
      code: "approval_not_supported_for_custom_stage",
      field: `${path}.approval_enabled`,
      message: `llm.approval_enabled=true is only wired for stage 'implement' (got '${stageName}')`,
      value: stageName,
      params: { field: `${path}.approval_enabled`, value: stageName },
    });
  }

  if (stageName in LEGACY_STAGE_TO_KIND && hasKind) {
    const expected = LEGACY_STAGE_TO_KIND[stageName];
    if (kind !== expected) {
      errors.push({
        code: "mismatched_post_process_kind",
        field: `${path}.post_process_kind`,
        message: `llm.post_process_kind '${kind}' disagrees with legacy stage '${stageName}' (expected '${expected}')`,
        value: kind,
        params: { field: `${path}.post_process_kind`, value: kind },
      });
    }
  }
}

function validateAction(
  action: ActionDef | undefined,
  path: string,
  knownRoles: Set<string>,
  errors: PipelineValidationError[],
): void {
  if (!action || typeof action !== "object") return;

  if (action.move_to_column_type != null && !COLUMN_TYPES.has(action.move_to_column_type)) {
    errors.push({
      code: "invalid_move_to_column_type",
      field: `${path}.move_to_column_type`,
      message: `unknown move_to_column_type '${action.move_to_column_type}'`,
      value: action.move_to_column_type,
      params: {
        field: `${path}.move_to_column_type`,
        value: action.move_to_column_type,
      },
    });
  }

  if (Array.isArray(action.wake_roles)) {
    action.wake_roles.forEach((role) => {
      if (role && !knownRoles.has(role)) {
        errors.push({
          code: "invalid_wake_role",
          field: `${path}.wake_roles`,
          message: `wake_roles references unknown role '${role}'`,
          value: role,
          params: { field: `${path}.wake_roles`, value: role },
        });
      }
    });
  }

  if (action.branches && typeof action.branches === "object") {
    Object.entries(action.branches).forEach(([name, branchAction]) => {
      validateAction(
        branchAction,
        `${path}.branches.${name}`,
        knownRoles,
        errors,
      );
    });
  }
}

function validateSensors(
  stage: StageConfig,
  path: string,
  knownSensors: Set<string>,
  errors: PipelineValidationError[],
): void {
  const sensors = stage.sensors;
  if (!Array.isArray(sensors)) return;
  sensors.forEach((sensor, idx) => {
    if (sensor.name && !knownSensors.has(sensor.name)) {
      errors.push({
        code: "unknown_sensor_name",
        field: `${path}[${idx}].name`,
        message: `sensor '${sensor.name}' is not in the registered catalog`,
        value: sensor.name,
        params: { field: `${path}[${idx}].name`, value: sensor.name },
      });
    }
  });
}

export function errorsByField(
  errors: PipelineValidationError[],
): Map<string, PipelineValidationError[]> {
  const map = new Map<string, PipelineValidationError[]>();
  for (const err of errors) {
    const bucket = map.get(err.field) ?? [];
    bucket.push(err);
    map.set(err.field, bucket);
  }
  return map;
}
