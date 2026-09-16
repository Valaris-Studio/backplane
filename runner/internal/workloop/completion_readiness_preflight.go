// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

type CompletionReadinessReport struct {
	Verified   []string
	Unverified []string
}

// PreflightCompletionReadiness probes deployed server credentials separately
// from the DB-only role contract checks. Call once per enabled cycle, never cache.
func PreflightCompletionReadiness(ctx context.Context, client *valaris.Client, workspace, board string, cfg *valaris.BoardLoopConfig) (CompletionReadinessReport, error) {
	report := CompletionReadinessReport{}
	if cfg.CompletionPolicy == nil {
		return report, nil
	}
	readiness, err := client.GetCompletionReadiness(ctx, workspace, board)
	if err != nil {
		return report, err
	}
	if readiness.PolicyHash == "" || readiness.PolicyHash != cfg.CompletionPolicyHash {
		return report, fmt.Errorf("completion readiness policy changed; refresh the board before launching")
	}
	required := 0
	for _, check := range readiness.Checks {
		if check.Required {
			required++
		}
		label := readinessCheckLabel(check)
		if check.Required && check.Status != "verified" {
			return report, fmt.Errorf("completion readiness blocked: %s: %s", label, readinessRemedy(check.Code))
		}
		if check.Operation == "forge_write" && check.Status == "verified" {
			return report, fmt.Errorf("completion readiness incorrectly claims write verification from a read-only probe; deploy a compatible backend before launching")
		}
		switch check.Status {
		case "verified":
			report.Verified = append(report.Verified, label+": verified")
		default:
			report.Unverified = append(report.Unverified, label+": "+check.Status+" — "+readinessRemedy(check.Code))
		}
	}
	if required == 0 {
		return report, fmt.Errorf("completion readiness omitted required checks; deploy a compatible backend before launching")
	}
	if !readiness.Ready {
		return report, fmt.Errorf("completion readiness is not ready; resolve the board's repository or credential prerequisites before launching")
	}
	if err := validateReadinessProof(readiness.Checks); err != nil {
		return report, err
	}
	return report, nil
}

// Validate completeness of each reported repository's proof without reconstructing
// the backend-owned repository or candidate inventory.
func validateReadinessProof(checks []valaris.CompletionReadinessCheck) error {
	type proof struct {
		operations         map[string]bool
		source, connection string
	}
	repos := make(map[string]*proof)
	for _, check := range checks {
		if check.RepoID == "" {
			return fmt.Errorf("completion readiness omitted repository identity; deploy a compatible backend before launching")
		}
		p := repos[check.RepoID]
		if p == nil {
			p = &proof{operations: make(map[string]bool)}
			repos[check.RepoID] = p
		}
		if check.Operation == "forge_write" {
			continue
		}
		if !check.Required || check.Status != "verified" {
			return fmt.Errorf("completion readiness omitted required verification for %s; deploy a compatible backend before launching", readinessCheckLabel(check))
		}
		if check.CredentialSource == "" || (check.CredentialSource == "workspace_connection" && check.ConnectionID == "") || (check.CredentialSource == "platform" && check.ConnectionID != "") {
			return fmt.Errorf("completion readiness omitted consistent credential identity for %s; deploy a compatible backend before launching", readinessCheckLabel(check))
		}
		if p.source == "" {
			p.source, p.connection = check.CredentialSource, check.ConnectionID
		}
		if p.source != check.CredentialSource || p.connection != check.ConnectionID {
			return fmt.Errorf("completion readiness credential changed across repository checks; refresh the board and retry before launching")
		}
		p.operations[check.Operation] = true
	}
	for repoID, p := range repos {
		for _, operation := range []string{"repository_binding", "repository_read", "pull_requests_read"} {
			if !p.operations[operation] {
				return fmt.Errorf("completion readiness omitted required %s proof for repository %s; deploy a compatible backend before launching", operation, readinessSafeID(repoID))
			}
		}
	}
	return nil
}

var readinessIdentifier = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

func readinessSafeID(value string) string {
	if readinessIdentifier.MatchString(value) {
		return value
	}
	return "[identifier omitted]"
}
func readinessCheckLabel(check valaris.CompletionReadinessCheck) string {
	parts := []string{check.Operation}
	if check.RepoID != "" {
		parts = append(parts, "repository "+readinessSafeID(check.RepoID))
	}
	if check.CandidateID != "" {
		parts = append(parts, "candidate "+readinessSafeID(check.CandidateID))
	}
	switch check.CredentialSource {
	case "workspace_connection":
		label := "deployed workspace connection credential"
		if check.ConnectionID != "" {
			label += " " + readinessSafeID(check.ConnectionID)
		}
		parts = append(parts, label)
	case "platform":
		parts = append(parts, "deployed platform credential")
	}
	return strings.Join(parts, "; ")
}
func readinessRemedy(code string) string {
	switch code {
	case "repository_required":
		return "link a repository to this board before launching"
	case "credential_unavailable":
		return "configure the server-side repository credential before launching"
	case "credential_host_mismatch":
		return "bind a credential for the repository's forge host before launching"
	case "forge_unsupported":
		return "configure a forge supported by server-side readiness or upgrade the backend"
	case "forge_auth_failed":
		return "the deployed credential cannot read this repository or its pull requests; correct its repository access and permissions before launching"
	case "forge_not_found":
		return "verify the linked repository and preserved pull request exist and are visible to the deployed credential"
	case "forge_unavailable":
		return "restore server-side forge connectivity before launching"
	case "forge_response_invalid":
		return "verify the forge endpoint and deploy a compatible backend before launching"
	case "readiness_timeout":
		return "the server-side forge probe timed out; check connectivity and retry before launching"
	case "candidate_changed":
		return "the preserved pull request changed; reconcile the candidate with current evidence before resuming review"
	case "write_unverified":
		return "write and merge permissions remain unverified; this read-only check performs no write"
	default:
		return "inspect the board's server-side repository and credential configuration before launching"
	}
}
