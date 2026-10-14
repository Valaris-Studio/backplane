// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package policy holds the server-authored capture policy and its local cache.
package policy

import (
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// TrustWindow is how long a cached policy admits capture after its last
// successful refresh: offline laptops keep capturing, while a server pause or
// revocation still takes effect within a day.
const TrustWindow = 24 * time.Hour

// maxClockSkew tolerates small backward clock corrections without treating a
// freshly refreshed policy as coming from the future.
const maxClockSkew = 5 * time.Minute

const maxCacheBytes = 4 << 20

var ErrInvalid = errors.New("invalid_policy")

type Installation struct {
	ID             string `json:"id"`
	Paused         bool   `json:"paused"`
	AutoMatchRepos bool   `json:"auto_match_repos"`
	// EnabledAgents restricts capture to these harnesses; null (nil) means
	// every harness, an empty list means none.
	EnabledAgents []string `json:"enabled_agents"`
	ExcludeGlobs  []string `json:"exclude_globs"`
	// RetentionDays is how long the server keeps this device's sessions;
	// nil keeps them until the owner deletes them. Shown, never enforced here.
	RetentionDays *int `json:"retention_days"`
}

type Mapping struct {
	ID                string `json:"id"`
	WorkspaceID       string `json:"workspace_id"`
	BoardID           string `json:"board_id,omitempty"`
	RootPath          string `json:"root_path,omitempty"`
	RepoURLNormalized string `json:"repo_url_normalized,omitempty"`
	Origin            string `json:"origin,omitempty"`
	Enabled           bool   `json:"enabled"`
	ContentLevel      string `json:"content_level,omitempty"`
	// Capture is the server's MappingEffectiveCapture, passed to the desktop
	// as written; absent from servers that predate it.
	Capture json.RawMessage `json:"capture,omitempty"`
}

type CatalogRepo struct {
	WorkspaceSlug string `json:"workspace_slug"`
	// WorkspaceName is absent from servers that predate it.
	WorkspaceName     *string `json:"workspace_name,omitempty"`
	WorkspaceID       string  `json:"workspace_id"`
	BoardID           string  `json:"board_id"`
	BoardName         string  `json:"board_name"`
	RepoURLNormalized string  `json:"repo_url_normalized"`
}

type Policy struct {
	Installation Installation  `json:"installation"`
	Mappings     []Mapping     `json:"mappings"`
	RepoCatalog  []CatalogRepo `json:"repo_catalog"`
	// APIBaseURL is where launched agents call the API; it can differ from
	// the endpoint, which may expose only /api/companion/*. Absent from
	// servers that predate it.
	APIBaseURL string `json:"api_base_url,omitempty"`
	// RichCapture is the server's rich capture offer.
	RichCapture RichCapture `json:"rich_capture,omitzero"`
}

// AgentAPIBase is the API origin backplane-mcp should call: the advertised
// base when it is a bare https origin, else the paired endpoint.
//
// Any registrable domain is accepted on purpose (prod's API is on run.app,
// its endpoint on the web app's domain): the value comes from the endpoint
// itself, over the device's authenticated TLS channel, so it is exactly as
// trusted as the endpoint that already receives the agent key.
func (p Policy) AgentAPIBase(endpoint string) (string, APIBaseSource) {
	advertised := strings.TrimSpace(p.APIBaseURL)
	if advertised == "" {
		return endpoint, APIBaseAbsent
	}
	if origin, ok := httpsOrigin(advertised); ok {
		return origin, APIBaseAdvertised
	}
	return endpoint, APIBaseRejected
}

// APIBaseSource says where agents' API URL came from, a stable contract with
// status output and the launcher's log.
type APIBaseSource string

const (
	APIBaseAdvertised APIBaseSource = "advertised"
	// APIBaseAbsent and APIBaseRejected fall back to the paired endpoint.
	APIBaseAbsent   APIBaseSource = "absent"
	APIBaseRejected APIBaseSource = "rejected"
)

func httpsOrigin(raw string) (string, bool) {
	// url.Parse drops an empty "?" or "#", so their mere presence is checked.
	if strings.ContainsAny(raw, "?#") {
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" || parsed.User != nil {
		return "", false
	}
	if parsed.RawPath != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", false
	}
	host := strings.ToLower(parsed.Hostname())
	// A zone (fe80::1%en0) names an interface on one machine, not a server.
	if host == "" || strings.Contains(host, "%") {
		return "", false
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if strings.HasSuffix(parsed.Host, ":") {
		return "", false
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", false
		}
		host += ":" + strconv.Itoa(number)
	}
	return "https://" + host, true
}

// Validate checks only the members the companion depends on; anything else
// the server adds is ignored so additive API changes never break a device.
func (p Policy) Validate() error {
	if p.Installation.ID == "" {
		return ErrInvalid
	}
	for _, mapping := range p.Mappings {
		if mapping.ID == "" || mapping.WorkspaceID == "" {
			return ErrInvalid
		}
	}
	for _, repo := range p.RepoCatalog {
		if repo.RepoURLNormalized == "" || repo.WorkspaceID == "" {
			return ErrInvalid
		}
	}
	return nil
}

// harnessFamilies maps a harness to the integration whose switch it follows,
// as the backend's HARNESS_FAMILIES does: Codex CLI and Codex Desktop share
// one integration (the same hooks.json), and enabled_agents names only it.
var harnessFamilies = map[string]string{"codex_desktop": "codex_cli"}

func (p Policy) AgentEnabled(agentID string) bool {
	if p.Installation.EnabledAgents == nil {
		return true
	}
	if family, ok := harnessFamilies[agentID]; ok {
		agentID = family
	}
	for _, enabled := range p.Installation.EnabledAgents {
		if enabled == agentID {
			return true
		}
	}
	return false
}

type Cached struct {
	Policy      Policy    `json:"policy"`
	RefreshedAt time.Time `json:"refreshed_at"`
}

func (c Cached) Stale(now time.Time) bool {
	return now.Sub(c.RefreshedAt) > TrustWindow || c.RefreshedAt.After(now.Add(maxClockSkew))
}

// WithMapping returns a copy whose mapping list contains mapping, replacing
// any mapping with the same id.
func (c Cached) WithMapping(mapping Mapping) Cached {
	mappings := make([]Mapping, 0, len(c.Policy.Mappings)+1)
	for _, existing := range c.Policy.Mappings {
		if existing.ID != mapping.ID {
			mappings = append(mappings, existing)
		}
	}
	c.Policy.Mappings = append(mappings, mapping)
	return c
}

func Load(path string) (Cached, error) {
	var cached Cached
	if err := store.ReadJSON(path, maxCacheBytes, &cached); err != nil {
		return Cached{}, err
	}
	if err := cached.Policy.Validate(); err != nil {
		return Cached{}, err
	}
	return cached, nil
}

func Save(path string, cached Cached) error {
	return store.WriteJSON(path, cached)
}
