// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import "context"

// SensorKind distinguishes between deterministic and non-deterministic feedback.
type SensorKind int

const (
	// Computational sensors are fast, reliable, and deterministic.
	// Examples: linters (golangci-lint), test runners (go test), type checkers (tsc).
	// These produce binary pass/fail signals with structured diagnostics.
	Computational SensorKind = iota

	// Inferential sensors use LLM-based analysis for semantically richer feedback.
	// Examples: code review (the reviewer pipeline role), architectural analysis.
	// These produce probabilistic assessments that may vary between runs.
	Inferential
)

// SensorKind string tags used in the manifest catalog published to the platform.
// These are the wire-format representation — the SensorKind int type stays
// internal to Go.
const (
	SensorKindComputational = "computational"
	SensorKindInferential   = "inferential"
)

// SensorManifestEntry describes a sensor's identity and configuration shape.
// It is the serializable form the agent publishes to the platform so the UI
// and backend can discover which sensors are available without hard-coding them.
type SensorManifestEntry struct {
	Name          string         `json:"name"`
	Kind          string         `json:"kind"`
	DefaultConfig map[string]any `json:"default_config"`
	ConfigSchema  map[string]any `json:"config_schema,omitempty"`
	Description   string         `json:"description,omitempty"`
}

// SensorInput provides context for sensor evaluation.
type SensorInput struct {
	// FilesChanged lists paths modified by the agent in this execution.
	FilesChanged []string

	// Language is the primary programming language of the changes (e.g., "go", "python", "typescript").
	Language string

	// WorkingDir is the root directory of the repository being evaluated.
	WorkingDir string

	// CardID is the kanban card that triggered this work.
	CardID string

	// ExecutionID links this evaluation to a specific agent execution.
	ExecutionID string

	// PRBranch is the git branch containing the changes (if applicable).
	PRBranch string

	// Extra carries domain-specific context that doesn't fit the common fields.
	Extra map[string]any
}

// SensorResult holds the outcome of a sensor evaluation.
type SensorResult struct {
	// Passed indicates whether the sensor's criteria were met.
	Passed bool

	// Score is an optional numeric quality signal (0.0-1.0). Not all sensors produce scores.
	Score float64

	// Findings are individual issues or observations discovered by the sensor.
	Findings []Finding

	// Summary is a human-readable description of the evaluation outcome.
	Summary string

	// Duration is how long the evaluation took (useful for performance budgeting).
	DurationMS int64
}

// Finding represents a single issue or observation from a sensor.
type Finding struct {
	// Severity: "error", "warning", "info"
	Severity string

	// File and Line where the finding was located (empty for project-level findings).
	File string
	Line int

	// Message describes the finding.
	Message string

	// Rule identifies the check that produced this finding (e.g., "golint:exported").
	Rule string
}

// Sensor observes agent output and provides feedback signals.
//
// Architecture note (ref: Martin Fowler, "Harness Engineering", April 2026):
// Sensors are the feedback half of the harness. They evaluate AFTER the agent acts.
//
// Existing code that maps to this interface:
//   - The reviewer role (DataDrivenStrategy with review stage) is an inferential sensor:
//     it evaluates code via LLM review and produces approve/reject decisions with findings.
//   - Computational sensors: `go test` (GoTestSensor), future: `golangci-lint`, `tsc --noEmit`
//     runners that gate PRs before LLM review.
//
// The workloop will invoke sensors at the appropriate pipeline points:
//   - Post-implement (before ship): computational sensors catch lint/test failures
//   - Post-ship (review phase): inferential sensors provide semantic code review
type Sensor interface {
	// Name returns a unique identifier for this sensor (e.g., "go-test", "llm-reviewer").
	Name() string

	// Kind returns whether this sensor is Computational or Inferential.
	Kind() SensorKind

	// Evaluate runs the sensor against the given input and returns results.
	Evaluate(ctx context.Context, input SensorInput) (*SensorResult, error)
}
