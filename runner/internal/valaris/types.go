// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/harness"
)

// User represents a Valaris user (also the identity behind an agent's API key).
type User struct {
	ID        string  `json:"id"`
	Email     string  `json:"email"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
	CreatedAt string  `json:"created_at"`
}

// ApprovalStatus represents a response from the approval endpoint.
type ApprovalStatus struct {
	ID                string  `json:"id"`
	Status            string  `json:"status"`
	Category          string  `json:"category"`
	RiskScore         int     `json:"risk_score"`
	ActionDescription string  `json:"action_description"`
	DecisionReason    *string `json:"decision_reason"`
	ExpiresAt         string  `json:"expires_at"`
}

// BlockedCardInfo describes a card blocked by the circuit breaker.
type BlockedCardInfo struct {
	CardID            string `json:"card_id"`
	FailCount         int    `json:"fail_count"`
	ReworkCount       int    `json:"rework_count"`
	LastFailAt        string `json:"last_fail_at"`
	CooldownRemaining string `json:"cooldown_remaining"`
}

// HealthReport contains runtime health metrics sent in the heartbeat body.
type HealthReport struct {
	Version         string  `json:"version"`
	GoVersion       string  `json:"go_version"`
	Hostname        string  `json:"hostname"`
	StartedAt       string  `json:"started_at"`
	UptimeSeconds   int64   `json:"uptime_seconds"`
	CardsProcessed  int     `json:"cards_processed"`
	CardsFailed     int     `json:"cards_failed"`
	CardsSkipped    int     `json:"cards_skipped"`
	Status          string  `json:"status"`
	CurrentCardID   string  `json:"current_card_id"`
	CurrentBoardID  string  `json:"current_board_id"`
	LastErrorMsg    string  `json:"last_error"`
	LastErrorAt     string  `json:"last_error_at"`
	PollInterval    string  `json:"poll_interval"`
	CardTimeout     string  `json:"card_timeout"`
	HealthPort      int     `json:"health_port,omitempty"`
	DiscoverCostUSD float64 `json:"discover_cost_usd"`
	// T0.4 (post-ST#8 2026-04-17): BlockedCards, ConfigErrors, and
	// SensorCatalog intentionally do NOT use omitempty. An empty slice must
	// round-trip as `[]` so the backend's "missing field = don't update" logic
	// can clear stale values on clean heartbeats. Previously an empty
	// ConfigErrors dropped out of the payload entirely, so once an agent
	// reported a config error the backend remembered it forever.
	BlockedCards  []BlockedCardInfo             `json:"blocked_cards"`
	ConfigErrors  []ConfigError                 `json:"config_errors"`
	SensorCatalog []harness.SensorManifestEntry `json:"sensor_catalog"`
	// Loop-mode state (card 442ff0f2). omitempty throughout: pipeline-mode
	// runners send none of these, and a zero-value LoopState must not be
	// mistaken for a claim by the backend's "missing field = don't update"
	// logic. LoopBoardID is the board this process is BOUND to, distinct from
	// CurrentBoardID (a card the runner is passing through).
	LoopBoardID     string `json:"loop_board_id,omitempty"`
	LoopState       string `json:"loop_state,omitempty"`
	LoopParkReason  string `json:"loop_park_reason,omitempty"`
	LoopParkedSince string `json:"loop_parked_since,omitempty"`
}

// Loop states reported on the heartbeat. A closed vocabulary — the backend
// rejects anything else, so parked can never be spelled two ways.
const (
	LoopStateTicking = "ticking"
	LoopStateParked  = "parked"
	// LoopStateIdleWaiting is a keep-alive runner sitting on a board whose
	// loop an operator switched OFF. Distinct from parked, which means the
	// loop is running and has nothing actionable — the operator's next move
	// differs (flip the loop back on vs. unblock a card).
	LoopStateIdleWaiting = "idle_waiting"
)

// NewHealthReport returns a HealthReport with non-nil slice fields. Using this
// constructor guarantees the three "always-serialize" collections round-trip
// as `[]` rather than `null` when empty.
func NewHealthReport() *HealthReport {
	return &HealthReport{
		BlockedCards:  []BlockedCardInfo{},
		ConfigErrors:  []ConfigError{},
		SensorCatalog: []harness.SensorManifestEntry{},
	}
}

// ConfigError describes a specific configuration issue detected by the agent.
type ConfigError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Stage   string `json:"stage,omitempty"`
}

// TeamMembership represents an agent's membership in a team with a specific role.
type TeamMembership struct {
	TeamID   string `json:"team_id"`
	TeamName string `json:"team_name"`
	Role     string `json:"role"`
}

// BoardColumn represents a column in a board, used for resolving column names to IDs.
type BoardColumn struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Position   float64 `json:"position"`
	ColumnType string  `json:"column_type"`
}

// PromptConfig represents a prompt template fetched from the platform.
//
// ResolvedContent is Content plus the post_process imperative for the
// (role, stage) pair this prompt applies to, as defined by the workspace
// pipeline_config. Runners MUST prefer ResolvedContent; Content is the
// operator-authored source and may be missing the imperative when the
// operator edited a synthesized default (see B11 in the runner-launch
// walkthrough).
type PromptConfig struct {
	ID              string `json:"id"`
	Slug            string `json:"slug"`
	Stage           string `json:"stage"`
	AgentType       string `json:"agent_type"`
	TeamRole        string `json:"team_role"`
	Content         string `json:"content"`
	ResolvedContent string `json:"resolved_content"`
	Version         int    `json:"version"`
}

// EffectivePromptContent returns the prompt bytes the runner should send to
// the LLM. Prefers ResolvedContent when present (post-upgrade backends);
// falls back to Content for pre-upgrade backends that don't emit the field.
func EffectivePromptContent(pc PromptConfig) string {
	if pc.ResolvedContent != "" {
		return pc.ResolvedContent
	}
	return pc.Content
}

// BudgetStatus represents the budget cap state for an agent.
type BudgetStatus struct {
	BudgetUSD      *float64 `json:"budget_usd"`
	SpentUSD       float64  `json:"spent_usd"`
	RemainingUSD   *float64 `json:"remaining_usd"`
	PercentageUsed *float64 `json:"percentage_used"`
	IsExceeded     bool     `json:"is_exceeded"`
}

// PlatformConfig represents the composite config fetched from GET /api/agents/me/config.
type PlatformConfig struct {
	AgentID              string              `json:"agent_id"`
	Name                 string              `json:"name"`
	AgentType            string              `json:"agent_type"`
	IsActive             bool                `json:"is_active"`
	MaxRequestsPerMinute int                 `json:"max_requests_per_minute"`
	BudgetUSD            *float64            `json:"budget_usd"`
	SpentUSD             float64             `json:"spent_usd"`
	RemainingUSD         *float64            `json:"remaining_usd"`
	BudgetExceeded       bool                `json:"budget_exceeded"`
	TeamID               *string             `json:"team_id"`
	TeamRole             *string             `json:"team_role"`
	TeamRoles            []string            `json:"team_roles"`
	BoardID              *string             `json:"board_id"`
	PromptConfigs        []PromptConfig      `json:"prompt_configs"`
	WorkspaceConfig      WorkspaceConfigData `json:"workspace_config"`
}

// WorkspaceConfigData holds platform-managed workspace parameters.
type WorkspaceConfigData struct {
	MaxReworkAttempts     int             `json:"max_rework_attempts"`
	CardCooldownHours     float64         `json:"card_cooldown_hours"`
	CommitMessageTemplate string          `json:"commit_message_template"`
	PRDescriptionTemplate string          `json:"pr_description_template"`
	Version               int             `json:"version"`
	PipelineConfig        *PipelineConfig `json:"pipeline_config"`
}

// PipelineConfig defines the configurable agent pipeline. The platform is
// authoritative: Loop.New refuses to start when the platform returns nil
// here. See feedback_backend_authoritative_config.md.
type PipelineConfig struct {
	Version    int           `json:"version"`
	Stages     []StageConfig `json:"stages"`
	Scheduling SchedulingDef `json:"scheduling"`
	// PAR-2: when true, reviewer-approve enqueues the PR onto the backend
	// merge queue instead of running runner-side applyApproveMergeGate.
	// Default false preserves pre-PAR-2 behavior bit-for-bit. Flip per
	// workspace once the backend worker has burn-in time in prod.
	MergeViaQueue bool `json:"merge_via_queue,omitempty"`
}

// StageConfig defines one role's behavior in the pipeline.
//
// The legacy shape (Discover/Claim/Git/LLM/Sensors/OnSuccess/OnFailure) is the
// flat, role-typed schema that the original three-strategy pipeline used and
// remains the back-compat path. Lifecycle is the new generic step list (closed-
// set kinds; see internal/lifecycle) the runner's lifecycle walker dispatches
// on. When Lifecycle is non-empty, the walker runs and the legacy fields are
// ignored at execution time (validation still applies via lifecycle param
// schemas). When Lifecycle is empty, the legacy DataDrivenStrategy.Tick path
// runs unchanged.
type StageConfig struct {
	Role      string      `json:"role"`
	Discover  DiscoverDef `json:"discover"`
	Claim     ClaimDef    `json:"claim"`
	Git       GitDef      `json:"git"`
	LLM       LLMDef      `json:"llm"`
	Sensors   []SensorDef `json:"sensors"`
	OnSuccess ActionDef   `json:"on_success"`
	OnFailure ActionDef   `json:"on_failure"`
	// Lifecycle is the optional explicit step DSL. When set, the runner's
	// lifecycle walker dispatches on step.Kind and the legacy fields above are
	// not consulted at runtime. Empty preserves bit-for-bit legacy behavior.
	Lifecycle []LifecycleStep `json:"lifecycle,omitempty"`
}

// LifecycleStep is one entry in a stage's explicit lifecycle DSL.
//
// Mirrors backend/app/services/agents/pipeline_config.py:LifecycleStepConfig
// and frontend lifecycle types. The struct intentionally lives in this package
// (not in internal/lifecycle) so the wire-level StageConfig type stays in one
// place; the lifecycle package consumes this type rather than redefining it.
//
//   - Name           identifier unique within the stage; referenced by Next/Branches.
//   - Kind           closed-set kind name; see internal/lifecycle.Kinds.
//   - Params         free-form per-kind params; each handler reads its own keys.
//   - Next           optional default next step when no branch decision fires.
//   - Branches       optional decision→step map for kinds that produce a decision.
//   - OnFailure      optional step name to route to when this step's handler
//     returns a non-ErrNoWork error. Failure handlers do not
//     recurse — a failure inside a failure handler propagates.
type LifecycleStep struct {
	Name      string            `json:"name"`
	Kind      string            `json:"kind"`
	Params    map[string]any    `json:"params,omitempty"`
	Next      string            `json:"next,omitempty"`
	Branches  map[string]string `json:"branches,omitempty"`
	OnFailure string            `json:"on_failure,omitempty"`
}

// DiscoverDef configures how a role discovers cards.
//
// Supported filter keys (values in Filters map):
//   - "require_git_repo"        (bool, default true)   skip cards on boards with no git repo
//   - "require_pr_url"          (bool)                  skip cards without a PR URL in description
//   - "include_label"           (string)                restrict candidates to cards carrying this label (server-side filter)
//   - "exclude_label"           (string)                skip cards already carrying this label
//   - "skip_if_pipeline_role"   (string)                canonical: skip cards where the agent is already a participant with this role
//   - "skip_if_participant_role" (string, deprecated)   alias of skip_if_pipeline_role; the canonical key wins when both are set
//   - "skip_self_reviewed"      (bool, legacy)          equivalent to skip_if_pipeline_role: "reviewer"; kept for back-compat
//   - "allow_self_participant"  (bool)                  opt out of the review-kind default guard (see below)
//
// Self-participation: a stage with column_type "review" and no skip_if_* key
// defaults to guarding against its OWN role, so a custom reviewer never re-picks
// a card it already processed. Set allow_self_participant: true to opt out.
// Other column types get no such default.
//
// On conflict between include_label and exclude_label (a card carries both),
// exclude_label wins — a card marked "already handled" is never re-picked.
type DiscoverDef struct {
	Strategy          string         `json:"strategy"`            // "unassigned_or_rework", "column_scan", "label_scan"
	ColumnType        string         `json:"column_type"`         // filter to this column_type (empty = any)
	ColumnTypeExclude string         `json:"column_type_exclude"` // exclude this column_type
	Filters           map[string]any `json:"filters"`             // see doc comment for supported keys
	// Preconditions are role-scoped scheduling gates evaluated server-side
	// by the /next-assignment endpoint. Current names: "repo_has_no_open_pr".
	// Empty/missing = no preconditions. Validation: backend rejects unknown
	// names with 422; mirrors backend/app/services/scheduling/preconditions.py.
	Preconditions []string `json:"preconditions,omitempty"`
}

// ClaimDef configures how a role claims a card.
type ClaimDef struct {
	ParticipantRole string `json:"participant_role"` // "hero" or "helper"
	ExecutionAction string `json:"execution_action"` // "implement_card", "review_card", "document_card", etc.
	// PipelineRole names the pipeline stage performing the claim (e.g. "reviewer",
	// "implementer"). Sent on the helper-claim AddCardParticipant write so the
	// backend can attribute claims by stage even when several stages share
	// participant_role="helper". Empty preserves legacy back-compat.
	PipelineRole string `json:"pipeline_role,omitempty"`
	// LogVerb overrides the verb in the execution-log description ("<LogVerb> card").
	// Empty derives the verb from ExecutionAction, then from Role.
	LogVerb string `json:"log_verb,omitempty"`
}

// GitDef configures git operations for a role.
type GitDef struct {
	Action            string `json:"action"`        // "create_branch", "checkout_pr_branch", "checkout_integration_head", "none"
	BranchPrefix      string `json:"branch_prefix"` // e.g., "docs-" for documentator
	CreatePR          bool   `json:"create_pr"`
	ForcePushOnRework bool   `json:"force_push_on_rework"`
	// BaseRef selects which ref CreateBranch forks off when Action="create_branch".
	// "" or "default_branch" preserves pre-PAR-1 behavior; "integration_branch"
	// forks from the repo's configured staging branch so concurrent runners on
	// the same repo see each other's in-flight work. Mirrors backend frozenset
	// _GIT_BASE_REFS in app/services/pipeline_config_validation.py.
	BaseRef string `json:"base_ref,omitempty"`
}

// GitBaseRefs is the closed set of values BaseRef accepts. Mirrors the
// backend frozenset; update both sides together.
var GitBaseRefs = map[string]bool{
	"default_branch":     true,
	"integration_branch": true,
}

// LLMDef configures the LLM phase for a role.
//
// `Stage` is a prompt-template lookup key. When `PostProcessKind` is set, the
// stage name is free-form — any value works, and the kind tells the engine how
// to handle the LLM's output. When `PostProcessKind` is empty, the legacy
// closed enum {"implement", "review", "document"} still applies and the kind
// is derived from the stage (see LegacyPostProcessKind).
//
// Values for `PostProcessKind`:
//   - "writes_code"        LLM changed files; engine runs gitCommitAndPush
//   - "produces_decision"  LLM emitted a decision string; engine routes via
//     ActionDef.Branches; no git push
//   - "produces_note"      LLM emitted findings to persist as a note
//   - "mutates_backlog"    LLM already wrote the side-effects via MCP tools
//     (create_card/update_card); no git, no note
type LLMDef struct {
	Enabled          bool     `json:"enabled"`
	Stage            string   `json:"stage"`                       // prompt template key
	PostProcessKind  string   `json:"post_process_kind,omitempty"` // writes_code|produces_decision|produces_note|mutates_backlog
	Tools            []string `json:"tools"`                       // allowed MCP tools
	InjectDirectives bool     `json:"inject_directives"`           // fetch and inject project directives
	ApprovalEnabled  bool     `json:"approval_enabled"`            // can request approval
	// Provider/Model mirror the backend flat stage.llm block
	// (workspace_config.DEFAULT_PIPELINE_CONFIG). Model may be a tier alias
	// (premium/mid/low) that only the backend's resolver can translate to a
	// concrete model, or a literal. The legacy-discover fallback reads these
	// so a stage with a declared model never dispatches on the runner's yaml
	// default (card e6d468ab). Lifecycle llm-step params take precedence —
	// same split-brain resolution as the backend's /next-assignment.
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
	// UseMinimalPromptWhenUnauthored opts this stage into running the platform's
	// minimal agentic prompt when no user-authored override exists and no
	// hardcoded Go fallback is registered. Default false — the safe behavior is
	// to graceful-skip rather than guess-execute on a stage whose intent the
	// user hasn't described yet. Set to true when the stage is "read-mostly"
	// (produces_note, updates_card) and you want exploration without waiting
	// for prompt authoring.
	UseMinimalPromptWhenUnauthored bool `json:"use_minimal_prompt_when_unauthored,omitempty"`
}

// LegacyPostProcessKind maps a default stage name to its implied kind so
// existing configs behave identically without setting PostProcessKind.
// Returns "" for unknown stages — caller handles as an engine error.
func LegacyPostProcessKind(stage string) string {
	switch stage {
	case "implement":
		return "writes_code"
	case "review":
		return "produces_decision"
	case "document":
		return "writes_code"
	default:
		return ""
	}
}

// EffectivePostProcessKind returns the explicit kind if set, otherwise the
// legacy mapping derived from the stage name.
func (d LLMDef) EffectivePostProcessKind() string {
	if d.PostProcessKind != "" {
		return d.PostProcessKind
	}
	return LegacyPostProcessKind(d.Stage)
}

// SensorDef configures a computational sensor to run after the LLM phase.
//
// OnPass/OnFail produce a decision string that feeds ActionDef.Branches for
// post-action routing (see DataDrivenStrategy.postActionWithConfig). Leave
// both empty to preserve the legacy aggregated failure path (any sensor
// failure triggers CreateReviewNote + failWithConfig + recordFailure).
type SensorDef struct {
	Name   string         `json:"name"`              // sensor registry name: "go-test", "eslint"
	Config map[string]any `json:"config"`            // sensor-specific config
	OnPass string         `json:"on_pass,omitempty"` // decision emitted when sensor passes (e.g., "pass")
	OnFail string         `json:"on_fail,omitempty"` // decision emitted when sensor fails (e.g., "fail")
}

// ActionDef configures post-action behavior on success or failure.
type ActionDef struct {
	MoveToColumnType   string               `json:"move_to_column_type"`  // target column type (empty = stay)
	StayInColumn       bool                 `json:"stay_in_column"`       // don't move card (documentator failure)
	Unassign           bool                 `json:"unassign"`             // remove agent from card
	WakeRoles          []string             `json:"wake_roles"`           // roles to wake in scheduler
	AddLabel           string               `json:"add_label"`            // label to add (e.g., "documented")
	RemoveLabel        string               `json:"remove_label"`         // label to clear (e.g., rework must drop "tested")
	CleanupReviewNotes bool                 `json:"cleanup_review_notes"` // delete review notes
	CreateReviewNote   bool                 `json:"create_review_note"`   // create note from LLM findings
	AppendLearning     bool                 `json:"append_learning"`      // append findings to board definition
	UnassignSelf       bool                 `json:"unassign_self"`        // remove self from card participants
	Conditional        bool                 `json:"conditional"`          // use branches based on LLM decision
	Branches           map[string]ActionDef `json:"branches"`             // keyed by decision: "approve", "request_changes", "pass", "fail"
}

// SchedulingDef configures multi-role scheduling.
type SchedulingDef struct {
	PriorityOrder []string `json:"priority_order"`
	// Mode selects the selection algorithm. "priority" (default) honors
	// priority_order strictly; "round_robin" rotates through priority_order
	// skipping idle-cooldown roles. Empty/unknown values fall back to "priority".
	Mode string `json:"mode"`

	// Deprecated: retained for JSON-parser tolerance against old platform
	// payloads and old local YAML. Runtime ignores both — the previous
	// consecutive-cap + starvation guard overrode user priority intent and was
	// removed (see memory/feedback_scheduler_consecutive_guard.md).
	MaxConsecutive       int  `json:"max_consecutive"`
	StarvationPrevention bool `json:"starvation_prevention"`

	// MinFailureBackoffSeconds is the minimum wait between poll cycles after a
	// tick returns an error. Prevents thundering-failure loops where pre-LLM
	// errors (e.g., budget-check 429, git clone failures) retry instantly and
	// burn API quota. Zero uses the built-in default (5s); negative is treated
	// as zero.
	MinFailureBackoffSeconds int `json:"min_failure_backoff_seconds"`
}

// ProjectDirectives holds the structured board definition plus pinned note
// content extracted from the board context. The Go agent injects these
// directly into the implement prompt so the LLM can't miss them.
//
// Field set + Format() output mirror the backend's server-rendered
// `board_definition` context source (backend/app/services/agents/
// context_assembly.py _fetch_board_definition) so the legacy REST path and
// the context_sources path produce equivalent prompts.
type ProjectDirectives struct {
	Scope           string
	Objectives      []DefinitionObjective
	Constraints     []string
	Exclusions      []string
	CodingStandards string
	TechStack       []string
	Decisions       []DefinitionDecision
	Milestones      []DefinitionMilestone
	Stakeholders    []DefinitionStakeholder
	References      []DefinitionReference
	PinnedNotes     []PinnedNote
}

// DefinitionObjective is one goal with an optional priority tag.
type DefinitionObjective struct {
	Text     string
	Priority string
}

// DefinitionDecision is a key decision with optional rationale.
type DefinitionDecision struct {
	Decision  string
	Rationale string
}

// DefinitionMilestone is a dated milestone with an optional type tag.
type DefinitionMilestone struct {
	Title string
	Date  string
	Type  string
}

// DefinitionStakeholder is a named stakeholder with an optional role.
type DefinitionStakeholder struct {
	Name string
	Role string
}

// DefinitionReference is an external reference with an optional label.
type DefinitionReference struct {
	Label string
	URL   string
}

// PinnedNote is a board note that is pinned (i.e. a directive/standard).
type PinnedNote struct {
	Title   string
	Content string
}

// Format renders directives as a two-tier text block for prompt injection:
// MANDATORY (rules the agent must obey) + PROJECT CONTEXT (reference). Empty
// sections are omitted. The header style matches the backend renderer exactly.
func (d *ProjectDirectives) Format() string {
	if d == nil {
		return ""
	}
	var parts []string
	if d.Scope != "" {
		parts = append(parts, "PROJECT SCOPE:\n"+d.Scope)
	}
	if mandatory := d.formatMandatory(); mandatory != "" {
		parts = append(parts, mandatory)
	}
	if context := d.formatProjectContext(); context != "" {
		parts = append(parts, context)
	}
	for _, n := range d.PinnedNotes {
		parts = append(parts, "NOTE — "+n.Title+":\n"+n.Content)
	}
	return strings.Join(parts, "\n\n")
}

func (d *ProjectDirectives) formatMandatory() string {
	var sections []string
	if len(d.Objectives) > 0 {
		lines := make([]string, len(d.Objectives))
		for i, o := range d.Objectives {
			line := "- " + o.Text
			if o.Priority != "" {
				line += " [" + o.Priority + "]"
			}
			lines[i] = line
		}
		sections = append(sections, "OBJECTIVES:\n"+strings.Join(lines, "\n"))
	}
	if len(d.Constraints) > 0 {
		sections = append(sections, "CONSTRAINTS:\n"+bulletList(d.Constraints))
	}
	if len(d.Exclusions) > 0 {
		sections = append(sections, "EXCLUSIONS:\n"+bulletList(d.Exclusions))
	}
	if d.CodingStandards != "" {
		sections = append(sections, "CODING STANDARDS:\n"+d.CodingStandards)
	}
	if len(sections) == 0 {
		return ""
	}
	return "## MANDATORY\n\n" + strings.Join(sections, "\n\n")
}

func (d *ProjectDirectives) formatProjectContext() string {
	var sections []string
	if len(d.TechStack) > 0 {
		sections = append(sections, "TECH STACK:\n"+bulletList(d.TechStack))
	}
	if len(d.Decisions) > 0 {
		lines := make([]string, len(d.Decisions))
		for i, dec := range d.Decisions {
			line := "- " + dec.Decision
			if dec.Rationale != "" {
				line += " — " + dec.Rationale
			}
			lines[i] = line
		}
		sections = append(sections, "KEY DECISIONS:\n"+strings.Join(lines, "\n"))
	}
	if len(d.Milestones) > 0 {
		lines := make([]string, len(d.Milestones))
		for i, m := range d.Milestones {
			line := "- " + m.Title + " (" + m.Date + ")"
			if m.Type != "" {
				line += " [" + m.Type + "]"
			}
			lines[i] = line
		}
		sections = append(sections, "MILESTONES:\n"+strings.Join(lines, "\n"))
	}
	if len(d.Stakeholders) > 0 {
		lines := make([]string, len(d.Stakeholders))
		for i, s := range d.Stakeholders {
			line := "- " + s.Name
			if s.Role != "" {
				line += " — " + s.Role
			}
			lines[i] = line
		}
		sections = append(sections, "STAKEHOLDERS:\n"+strings.Join(lines, "\n"))
	}
	if len(d.References) > 0 {
		lines := make([]string, len(d.References))
		for i, r := range d.References {
			if r.Label != "" {
				lines[i] = "- " + r.Label + ": " + r.URL
			} else {
				lines[i] = "- " + r.URL
			}
		}
		sections = append(sections, "REFERENCES:\n"+strings.Join(lines, "\n"))
	}
	if len(sections) == 0 {
		return ""
	}
	return "## PROJECT CONTEXT\n\n" + strings.Join(sections, "\n\n")
}

func bulletList(items []string) string {
	lines := make([]string, len(items))
	for i, item := range items {
		lines[i] = "- " + item
	}
	return strings.Join(lines, "\n")
}

// fillDirectivesFromContent extracts the structured definition fields from the
// untyped `content` blob. Every assertion is defensive: a missing or
// wrong-typed key is skipped, never panics. This keeps the JSON contract
// forward+backward compatible — an old backend serving only coding_standards
// still produces exactly the legacy block.
func fillDirectivesFromContent(d *ProjectDirectives, content map[string]any) {
	if content == nil {
		return
	}
	d.CodingStandards = strings.TrimSpace(stringField(content, "coding_standards"))
	d.Constraints = stringSlice(content["constraints"])
	d.Exclusions = stringSlice(content["exclusions"])
	d.TechStack = stringSlice(content["tech_stack"])

	for _, item := range objectSlice(content["objectives"]) {
		if text := strings.TrimSpace(stringField(item, "text")); text != "" {
			d.Objectives = append(d.Objectives, DefinitionObjective{
				Text:     text,
				Priority: stringField(item, "priority"),
			})
		}
	}
	for _, item := range objectSlice(content["decisions"]) {
		if dec := strings.TrimSpace(stringField(item, "decision")); dec != "" {
			d.Decisions = append(d.Decisions, DefinitionDecision{
				Decision:  dec,
				Rationale: stringField(item, "rationale"),
			})
		}
	}
	for _, item := range objectSlice(content["milestones"]) {
		if title := strings.TrimSpace(stringField(item, "title")); title != "" {
			d.Milestones = append(d.Milestones, DefinitionMilestone{
				Title: title,
				Date:  stringField(item, "date"),
				Type:  stringField(item, "type"),
			})
		}
	}
	for _, item := range objectSlice(content["stakeholders"]) {
		if name := strings.TrimSpace(stringField(item, "name")); name != "" {
			d.Stakeholders = append(d.Stakeholders, DefinitionStakeholder{
				Name: name,
				Role: stringField(item, "role"),
			})
		}
	}
	for _, item := range objectSlice(content["references"]) {
		if url := strings.TrimSpace(stringField(item, "url")); url != "" {
			d.References = append(d.References, DefinitionReference{
				Label: stringField(item, "label"),
				URL:   url,
			})
		}
	}
}

func stringField(m map[string]any, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

func stringSlice(v any) []string {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, item := range raw {
		if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func objectSlice(v any) []map[string]any {
	raw, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []map[string]any
	for _, item := range raw {
		if obj, ok := item.(map[string]any); ok {
			out = append(out, obj)
		}
	}
	return out
}

// boardContextResponse mirrors the JSON shape of GET /api/workspaces/{slug}/boards/{board_id}/context.
// `scope` is a top-level field on the backend DefinitionSummary (sibling of
// `content`), not a content key.
type boardContextResponse struct {
	Definition *struct {
		Scope   string         `json:"scope"`
		Content map[string]any `json:"content"`
	} `json:"definition"`
}

// noteResponse mirrors the JSON shape of a single note from GET .../notes.
type noteResponse struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content"`
	Pinned  bool   `json:"pinned"`
}

// ReviewNote is a note associated with a card, created by the reviewer agent
// to record findings. Uses the same JSON shape as noteResponse but is exported
// for use by the work loop (mediator review history injection).
type ReviewNote struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

// CardVerdict is the immutable review verdict-of-record for a card. The
// orchestrator's Done-gate consults this before honoring a merged-PR
// shortcut — without an "approve" verdict, the shortcut is blocked.
type CardVerdict struct {
	Decision  string `json:"decision"`
	NoteID    string `json:"note_id"`
	CreatedAt string `json:"created_at"`
}

// Card represents a card fetched from the API.
// ColumnType mirrors CardRead.column_type from the backend and is the
// defense-in-depth signal that gates agent claimability — empty means the
// card sits in an untyped column and MUST NOT be picked up by runner loops.
type Card struct {
	ID           string            `json:"id"`
	ColumnID     string            `json:"column_id"`
	ColumnType   string            `json:"column_type"`
	BoardID      string            `json:"board_id"`
	Title        string            `json:"title"`
	Description  string            `json:"description"`
	CardType     string            `json:"card_type"`
	Priority     string            `json:"priority"`
	Position     float64           `json:"position"`
	DueDate      *string           `json:"due_date"`
	Status       string            `json:"status"`
	Labels       []string          `json:"labels"`
	Participants []CardParticipant `json:"participants"`
	CreatedAt    string            `json:"created_at"`
	UpdatedAt    string            `json:"updated_at"`
	// BudgetUSDOverride is the per-card budget ceiling (Card.budget_usd_override,
	// migration 067). nil = use the workspace/yaml max_budget_usd. Surfaced on the
	// next-assignment bundle so the runner can give an outsized card more runway
	// without editing the global config.
	BudgetUSDOverride *float64 `json:"budget_usd_override,omitempty"`
	// GitRepoSlug is the card's target repo on a multi-repo board (CardRead
	// `git_repo_slug`). Empty = board primary. The runner inherits it onto
	// follow-up fix cards so they route to the same registered repo.
	GitRepoSlug string `json:"git_repo_slug,omitempty"`
}

// CardParticipant represents a user's role on a card.
type CardParticipant struct {
	UserID  string `json:"user_id"`
	AgentID string `json:"agent_id"`
	Role    string `json:"role"`
}

// GitRepo represents a git repository linked to a board.
type GitRepo struct {
	ID                      string `json:"id"`
	Name                    string `json:"name"`
	Slug                    string `json:"slug"`
	URL                     string `json:"url"`
	DefaultBranch           string `json:"default_branch"`
	Provider                string `json:"provider"`
	RequireBranchProtection bool   `json:"require_branch_protection"`
}

// Board represents a board in a workspace.
type Board struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
}

// Workspace is one entry of GET /api/workspaces. It models only the identity
// fields of the backend's WorkspaceRead — the aggregates it may also carry
// (board_count, last_activity_at) are list-view chrome the runner never reads.
type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// Execution represents an execution record.
type Execution struct {
	ID      string `json:"id"`
	AgentID string `json:"agent_id"`
	Status  string `json:"status"`
}

// SearchCardsParams holds filter parameters for card search.
type SearchCardsParams struct {
	AssigneeID        string
	ColumnType        string
	ExcludeColumnType string
	HasAssignee       *bool
	Label             string
	Priority          string
	Limit             int
	// AllDependenciesDone pushes the scheduler's dependency gate into the
	// card search: only cards whose every card_dependencies row resolves to
	// a done column are returned. Same server-side predicate the backend
	// /next-assignment applies for discover.filters.all_dependencies_done.
	AllDependenciesDone bool
}

// LoopCompletionQuery is a curated run's completion condition: zero cards
// carrying Label outside the done column means the run is over. The shape is
// deliberately the cards-search contract, so the runner evaluates it with the
// same endpoint an agent would — no second query language to keep in sync.
type LoopCompletionQuery struct {
	Label             string `json:"label"`
	ExcludeColumnType string `json:"exclude_column_type"`
}

// BoardLoopReasonCode is the stable identifier for an automatic loop stop.
// The legacy human-readable reason remains required on the wire so older
// clients and servers can continue to display the stop without this field.
type BoardLoopReasonCode string

const (
	BoardLoopReasonMaxIterationsReached BoardLoopReasonCode = "max_iterations_reached"
	BoardLoopReasonBudgetExhausted      BoardLoopReasonCode = "budget_exhausted"
	BoardLoopReasonConsecutiveFailures  BoardLoopReasonCode = "consecutive_failures"
)

// BoardLoopStructuredReason carries additive, machine-readable context for
// an automatic stop. Params contain only the technical values represented by
// Code; Diagnostic is optional raw technical detail and is never localized.
type BoardLoopStructuredReason struct {
	Code       BoardLoopReasonCode
	Params     map[string]any
	Diagnostic string
}

// BoardLoopConfig is the board-scoped loop mode config served verbatim by
// GET/PUT .../loop (docs/loop-mode-contract.md "Config schema"): what you PUT
// is what GET returns, plus server-applied defaults. The runner treats it as
// fully authoritative and re-fetches it at the top of every iteration — there
// is no runner-side fallback or caching across iterations.
//
// The backend grows this payload additively (loop templates add a `template`
// ref object; board-loop keys like loop_landing/merge_gate the runner never
// reads already ride along), so decoding MUST stay lenient about unknown
// keys — never DisallowUnknownFields here. Pinned by
// TestGetBoardLoop_IgnoresUnknownTemplateRef.
type BoardLoopConfig struct {
	CompletionPolicy     *CompletionPolicy `json:"completion_policy"`
	CompletionPolicyHash string            `json:"completion_policy_hash"`
	CompletionContext    string            `json:"completion_context"`
	Enabled              bool              `json:"enabled"`
	Provider             string            `json:"provider"` // free string, white-label ("" = runner's default)
	// Model is a tier alias (premium/mid/low) or a concrete model id, same
	// dual contract as StageConfig.LLM.Model — see isTierAlias.
	Model                   string   `json:"model"`
	SystemPrompt            string   `json:"system_prompt"`
	LoopPrompt              string   `json:"loop_prompt"` // required non-empty to enable; the per-iteration user prompt
	Tools                   []string `json:"tools"`
	MaxIterations           int      `json:"max_iterations"`
	IterationDelaySeconds   int      `json:"iteration_delay_seconds"`
	IterationTimeoutSeconds int      `json:"iteration_timeout_seconds"`
	BudgetUSD               float64  `json:"budget_usd"`
	MaxConsecutiveFailures  int      `json:"max_consecutive_failures"`
	// MaxBlockedOnHuman stops the loop after N consecutive sessions reporting
	// outcome=blocked_on_human, with a reason naming the blocker. 0 (also what
	// a pre-rollout backend's absent field decodes to) opts out: blocked_on_human
	// then only parks, never disables.
	MaxBlockedOnHuman int `json:"max_blocked_on_human"`
	// StarvationPolicy: "park" (default — pre-flight GET /loop/readiness each
	// cycle, sleep for free when nothing is actionable) or "always_run" (v1
	// behavior for loops whose prompt does non-card work). "" from an older
	// backend behaves as park — such a backend also lacks the readiness
	// endpoint, so the runner's 404 fallback lands on always_run anyway.
	StarvationPolicy string `json:"starvation_policy"`
	// CompletionQuery is the run's declarative completion condition, evaluated
	// against the cards-search endpoint. nil (also what a pre-rollout backend's
	// absent field decodes to) = off: completion is then only ever a session's
	// self-report.
	CompletionQuery *LoopCompletionQuery `json:"completion_query"`
	// SkillsProposalEnabled gates the propose_skill MCP tool for this loop.
	// Backend-authoritative: enforcement happens server-side (the tool is
	// stripped from the served Tools allowlist and the proposals endpoint
	// rejects board-scoped proposals when false), so the runner never
	// branches on it. canonicalize_loop_config injects the default (true)
	// on every save, so a missing key — which json.Unmarshal decodes to
	// false — only occurs against pre-rollout backends, where false is the
	// honest value anyway (their backend rejects nothing but serves no
	// propose_skill either).
	SkillsProposalEnabled bool `json:"skills_proposal_enabled"`
	// DisabledReason records why the loop last turned off — set by humans,
	// agents (via set_board_loop), or a runner safety rail. nil = never
	// disabled, or currently enabled with no recorded reason.
	DisabledReason *string `json:"disabled_reason"`
	Version        int     `json:"version"`
	UpdatedAt      string  `json:"updated_at"`
	// BudgetEpoch is server-owned: stamped on every disabled→enabled flip.
	// Spent-since-epoch seeding (GET /loop/history) keys off it; re-enabling
	// the loop is the operator's budget reset lever.
	BudgetEpoch *string `json:"budget_epoch"`
}

// LoopHistory is the cross-run continuity aggregate (GET .../loop/history):
// all-time loop_iteration count (numbering stays monotonic across restarts)
// and cost summed since BudgetEpoch (all-time when the epoch is null).
type LoopHistory struct {
	IterationCount   int     `json:"iteration_count"`
	SpentUSD         float64 `json:"spent_usd"`
	LifetimeSpentUSD float64 `json:"lifetime_spent_usd"`
	BudgetEpoch      *string `json:"budget_epoch"`
}

// LoopReadiness is the board-level starvation probe (GET .../loop/readiness):
// "is there anything to do?" for the price of one HTTP GET. awaiting_merge is
// visibility metadata only — dependency satisfaction stays merged-only.
type LoopReadiness struct {
	PendingCompletion        int      `json:"pending_completion"`
	FailedCompletion         int      `json:"failed_completion"`
	ReadyCount               int      `json:"ready_count"`
	BlockedCount             int      `json:"blocked_count"`
	ExplicitlyBlockedCount   int      `json:"explicitly_blocked_count"`
	ExplicitlyBlockedCardIDs []string `json:"explicitly_blocked_card_ids"`
	AwaitingMergeCount       int      `json:"awaiting_merge_count"`
	ReviewOpenPRCount        int      `json:"review_open_pr_count"`
	Actionable               bool     `json:"actionable"`
}

// LoopStatus is the platform's loop truth layer (GET .../loop/status): config,
// in-flight iterations, and bound-agent liveness stitched server-side into ONE
// State. Every surface that names a board's loop state — web chip, TUI picker,
// any future runner UI — must render this State rather than re-deriving its
// own dialect. State is one of off | running | parked | waiting | unattended;
// unconfigured serves "off", never a 404.
type LoopStatus struct {
	State          string `json:"state"`
	Enabled        bool   `json:"enabled"`
	DisabledReason string `json:"disabled_reason"`
	// ParkReason is the runner's own account of why it is asleep, non-empty
	// only in State=="parked".
	ParkReason           string  `json:"park_reason"`
	Actionable           bool    `json:"actionable"`
	HasInflightIteration bool    `json:"has_inflight_iteration"`
	LastIterationAt      string  `json:"last_iteration_at"`
	LastIterationStatus  string  `json:"last_iteration_status"`
	BoundAgentCount      int     `json:"bound_agent_count"`
	AliveAgentCount      int     `json:"alive_agent_count"`
	SpentUSD             float64 `json:"spent_usd"`
	BudgetUSD            float64 `json:"budget_usd"`
}

// AgentConfig represents the agent identity, permissions, and constraints
// linked to an API key on the Valaris platform.
type AgentConfig struct {
	ID                   string          `json:"id"`
	Name                 string          `json:"name"`
	AgentType            string          `json:"agent_type"`
	Description          string          `json:"description"`
	IsActive             bool            `json:"is_active"`
	AllowedWorkspaces    []string        `json:"allowed_workspaces"`
	AllowedActions       []string        `json:"allowed_actions"`
	MaxRequestsPerMinute int             `json:"max_requests_per_minute"`
	BudgetUSD            *float64        `json:"budget_usd"`
	APIKeyPrefix         *string         `json:"api_key_prefix"`
	LastSeenAt           *string         `json:"last_seen_at"`
	CreatedAt            string          `json:"created_at"`
	UpdatedAt            string          `json:"updated_at"`
	TeamMembership       *TeamMembership `json:"team_membership"`
}
