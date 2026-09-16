// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"fmt"
)

// AssignmentSkill is one workspace skill bound to the card's board, as the
// backend resolved it for this assignment. Mirrors the backend response shape
// in app/schemas/agents/assignment.py — keep JSON tags in sync, same commit.
//
// Version + ContentHash are what make materialization cacheable: the runner
// fetches a version's files once per content hash and reuses the cached copy
// for every later card that resolves to the same hash.
type AssignmentSkill struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     int    `json:"version"`
	ContentHash string `json:"content_hash"`
}

// SkillFile is one file inside a published skill version. Path is relative to
// the skill's own directory (SKILL.md at the root, plus any nested references).
type SkillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// SkillVersionFiles is the published content of a single skill version.
type SkillVersionFiles struct {
	Version     int         `json:"version"`
	ContentHash string      `json:"content_hash"`
	Files       []SkillFile `json:"files"`
}

// FetchSkillVersionFiles downloads one published skill version's files.
func (c *Client) FetchSkillVersionFiles(
	ctx context.Context, workspaceSlug, skillSlug string, version int,
) (*SkillVersionFiles, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/skills/%s/versions/%d",
		c.baseURL, workspaceSlug, skillSlug, version)
	return jsonGet[*SkillVersionFiles](ctx, c, url)
}

// boardSkillsResponse is the envelope GET .../boards/{id}/skills returns.
type boardSkillsResponse struct {
	Skills []AssignmentSkill `json:"skills"`
}

// GetBoardEffectiveSkills returns the skills currently bound to a board. Used
// by loop mode, which has a board but no card assignment to carry the manifest.
func (c *Client) GetBoardEffectiveSkills(
	ctx context.Context, workspaceSlug, boardID string,
) ([]AssignmentSkill, error) {
	url := fmt.Sprintf("%s/api/workspaces/%s/boards/%s/skills", c.baseURL, workspaceSlug, boardID)
	resp, err := jsonGet[boardSkillsResponse](ctx, c, url)
	if err != nil {
		return nil, err
	}
	return resp.Skills, nil
}
