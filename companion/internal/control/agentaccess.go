// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"net/http"
)

// CodeMappingRootUnknown: an auto-repo mapping whose folder this device has
// not discovered, so no agent configuration can point at it.
const CodeMappingRootUnknown = "mapping_root_unknown"

// AgentAccessService lets agents work on bound boards (contract v1.4 §A).
// Its answers carry no key material and no agent configuration values.
type AgentAccessService interface {
	AgentAccess(context.Context) (any, error)
	SetAgentAccess(ctx context.Context, mappingID string, enabled bool) (any, error)
}

func agentAccessUnavailable() *Error {
	return &Error{Status: http.StatusNotImplemented, Code: CodeInvalidRequest, Message: "agent access unavailable"}
}

func (s *Server) agentAccess(w http.ResponseWriter, r *http.Request) error {
	if s.config.AgentAccess == nil {
		return agentAccessUnavailable()
	}
	access, err := s.config.AgentAccess.AgentAccess(r.Context())
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, access)
	return nil
}

func (s *Server) setAgentAccess(w http.ResponseWriter, r *http.Request) error {
	if s.config.AgentAccess == nil {
		return agentAccessUnavailable()
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeBody(r, &body); err != nil {
		return err
	}
	if body.Enabled == nil {
		return invalid("enabled is required")
	}
	access, err := s.config.AgentAccess.SetAgentAccess(r.Context(), r.PathValue("id"), *body.Enabled)
	if err != nil {
		return err
	}
	s.hub.publish("agent_access", access)
	s.writeJSON(w, http.StatusOK, access)
	return nil
}

// agentAccessEvent is the connect-time agent_access frame; nil without a
// service or when it cannot answer.
func (s *Server) agentAccessEvent(ctx context.Context) []byte {
	if s.config.AgentAccess == nil {
		return nil
	}
	access, err := s.config.AgentAccess.AgentAccess(ctx)
	if err != nil {
		s.config.Logf("control_api_agent_access: %v", err)
		return nil
	}
	frame, err := encodeEvent("agent_access", access)
	if err != nil {
		return nil
	}
	return frame
}
