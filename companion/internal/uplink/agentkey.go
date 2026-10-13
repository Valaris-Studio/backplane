// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// ErrAgentKeyMissing is the server's 404 agent_key_missing: the user deleted
// this device's agents key on the web. A bare 404 stays ErrNotFound.
var ErrAgentKeyMissing = errors.New("agent_key_missing")

// ErrAgentKeyRotationConflict is the server's 409: another mint for this
// installation ran at the same time.
var ErrAgentKeyRotationConflict = errors.New("agent_key_rotation_conflict")

const agentKeyPath = "/api/companion/agent-key"

// AgentKey is a freshly minted key; Key is its only appearance anywhere, and
// it goes straight to the keyring.
type AgentKey struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	KeyPrefix string    `json:"key_prefix"`
	Key       string    `json:"key"`
	CreatedAt time.Time `json:"created_at"`
}

// String and GoString keep the raw key out of any formatted output.
func (k AgentKey) String() string {
	return fmt.Sprintf("AgentKey{ID:%s KeyPrefix:%s}", k.ID, k.KeyPrefix)
}

func (k AgentKey) GoString() string { return k.String() }

type AgentKeyInfo struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	KeyPrefix  string     `json:"key_prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

// CreateAgentKey mints this installation's agents key, replacing any earlier
// one on the server.
func (c *Client) CreateAgentKey(ctx context.Context) (AgentKey, error) {
	data, err := c.object(ctx, http.MethodPost, agentKeyPath, nil)
	var status *StatusError
	if errors.As(err, &status) && status.Code == ErrAgentKeyRotationConflict.Error() {
		return AgentKey{}, fmt.Errorf("%w: %w", ErrAgentKeyRotationConflict, err)
	}
	if err != nil {
		return AgentKey{}, err
	}
	var key AgentKey
	if err := decode(data, &key); err != nil {
		return AgentKey{}, err
	}
	if key.ID == "" || !apiKeyPattern.MatchString(key.Key) {
		return AgentKey{}, fmt.Errorf("%w: agent key missing or malformed", ErrInvalidResponse)
	}
	return key, nil
}

func (c *Client) AgentKey(ctx context.Context) (AgentKeyInfo, error) {
	data, err := c.object(ctx, http.MethodGet, agentKeyPath, nil)
	var status *StatusError
	if errors.As(err, &status) && status.Code == ErrAgentKeyMissing.Error() {
		return AgentKeyInfo{}, fmt.Errorf("%w: %w", ErrAgentKeyMissing, err)
	}
	if err != nil {
		return AgentKeyInfo{}, err
	}
	var info AgentKeyInfo
	if err := decode(data, &info); err != nil {
		return AgentKeyInfo{}, err
	}
	if info.ID == "" {
		return AgentKeyInfo{}, fmt.Errorf("%w: agent key id missing", ErrInvalidResponse)
	}
	return info, nil
}

// DeleteAgentKey deletes every agents key of this installation; a key that
// is already gone is not an error.
func (c *Client) DeleteAgentKey(ctx context.Context) error {
	_, err := c.do(ctx, http.MethodDelete, agentKeyPath, c.token, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}
