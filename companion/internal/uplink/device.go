// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

// The device self-service calls answer with the server's documents as they
// are: the control API forwards them to the desktop app, which reads the
// members it knows. Only the members the companion itself depends on are
// checked.

// MappingRequest maps a root or a repository to a board the user chose.
type MappingRequest struct {
	WorkspaceID  string `json:"workspace_id"`
	BoardID      string `json:"board_id"`
	RootPath     string `json:"root_path,omitempty"`
	RepoURL      string `json:"repo_url,omitempty"`
	ContentLevel string `json:"content_level"`
	Enabled      *bool  `json:"enabled,omitempty"`
}

type MappingUpdate struct {
	ContentLevel *string `json:"content_level,omitempty"`
	Enabled      *bool   `json:"enabled,omitempty"`
}

// SettingsUpdate changes only the members that are set. EnabledAgents set to
// an empty list disables every harness.
type SettingsUpdate struct {
	AutoMatchRepos *bool     `json:"auto_match_repos,omitempty"`
	EnabledAgents  *[]string `json:"enabled_agents,omitempty"`
	ExcludeGlobs   *[]string `json:"exclude_globs,omitempty"`
}

type SessionQuery struct {
	Status string
	Limit  int
	Cursor string
}

func (c *Client) Boards(ctx context.Context) (json.RawMessage, error) {
	return c.object(ctx, http.MethodGet, "/api/companion/boards", nil)
}

func (c *Client) Mappings(ctx context.Context) (json.RawMessage, error) {
	data, err := c.do(ctx, http.MethodGet, "/api/companion/mappings", c.token, nil)
	if err != nil {
		return nil, err
	}
	if !json.Valid(data) {
		return nil, fmt.Errorf("%w: mappings are not JSON", ErrInvalidResponse)
	}
	return data, nil
}

func (c *Client) CreateMapping(ctx context.Context, request MappingRequest) (json.RawMessage, error) {
	return c.mapping(ctx, http.MethodPost, "/api/companion/mappings", request)
}

func (c *Client) UpdateMapping(ctx context.Context, id string, update MappingUpdate) (json.RawMessage, error) {
	return c.mapping(ctx, http.MethodPatch, "/api/companion/mappings/"+url.PathEscape(id), update)
}

func (c *Client) DeleteMapping(ctx context.Context, id string) error {
	_, err := c.do(ctx, http.MethodDelete, "/api/companion/mappings/"+url.PathEscape(id), c.token, nil)
	return err
}

func (c *Client) UpdateSettings(ctx context.Context, update SettingsUpdate) (json.RawMessage, error) {
	return c.object(ctx, http.MethodPatch, "/api/companion/settings", update)
}

func (c *Client) Sessions(ctx context.Context, query SessionQuery) (json.RawMessage, error) {
	values := url.Values{}
	if query.Status != "" {
		values.Set("status", query.Status)
	}
	if query.Limit > 0 {
		values.Set("limit", strconv.Itoa(query.Limit))
	}
	if query.Cursor != "" {
		values.Set("cursor", query.Cursor)
	}
	path := "/api/companion/sessions"
	if encoded := values.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return c.object(ctx, http.MethodGet, path, nil)
}

func (c *Client) Session(ctx context.Context, id string) (json.RawMessage, error) {
	return c.object(ctx, http.MethodGet, "/api/companion/sessions/"+url.PathEscape(id), nil)
}

func (c *Client) SessionUsage(ctx context.Context, id string) (json.RawMessage, error) {
	return c.object(ctx, http.MethodGet, "/api/companion/sessions/"+url.PathEscape(id)+"/usage", nil)
}

// RenameInstallation renames this device as its owner sees it.
func (c *Client) RenameInstallation(ctx context.Context, name string) error {
	_, err := c.do(ctx, http.MethodPatch, "/api/companion/installation", c.token, map[string]string{"name": name})
	return err
}

func (c *Client) object(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	data, err := c.do(ctx, method, path, c.token, body)
	if err != nil {
		return nil, err
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil || members == nil {
		return nil, fmt.Errorf("%w: %s %s did not answer an object", ErrInvalidResponse, method, path)
	}
	return data, nil
}

func (c *Client) mapping(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	data, err := c.object(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	var mapping struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &mapping) != nil || mapping.ID == "" {
		return nil, fmt.Errorf("%w: mapping id missing", ErrInvalidResponse)
	}
	return data, nil
}

// Me is the installation's owner and the installation, as the server knows
// them.
type Me struct {
	User struct {
		Email       string `json:"email"`
		DisplayName string `json:"display_name"`
	} `json:"user"`
	Installation struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"installation"`
	// WebOrigin is the server's frontend origin, which may differ from the
	// API endpoint; nil when the server does not say.
	WebOrigin *string `json:"web_origin"`
}

func (c *Client) Me(ctx context.Context) (Me, error) {
	data, err := c.object(ctx, http.MethodGet, "/api/companion/me", nil)
	if err != nil {
		return Me{}, err
	}
	var me Me
	if err := decode(data, &me); err != nil {
		return Me{}, err
	}
	if me.User.Email == "" {
		return Me{}, fmt.Errorf("%w: me carries no user", ErrInvalidResponse)
	}
	return me, nil
}
