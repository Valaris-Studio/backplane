// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package uplinktest is a small in-process fake of the Backplane companion
// API, shared by package and integration tests.
package uplinktest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

const (
	APIKey      = "vlr_synthetic_test_key"
	DeviceToken = "bpc_synthetic_device_token_0123456789"
	// PairedInstallationID is the installation a granted pairing creates.
	PairedInstallationID = "7a1c0de5-0000-4000-8000-000000000001"
)

type IngestResponder func(captureIDs []string) (status int, body any)

type Server struct {
	*httptest.Server
	mu sync.Mutex

	Policy policy.Policy
	// Resolvable maps a normalized repo URL to the mapping the server creates.
	Resolvable map[string]policy.Mapping
	// MappingRefusals maps a normalized repo URL to a refusal status:
	// 409 ambiguous_repo, 403 auto_match_disabled or 422 unparseable URL.
	MappingRefusals map[string]int
	// Installed and Revoked track installation ids as the backend does.
	Installed map[string]bool
	Revoked   map[string]bool
	// TokenRevoked makes every device call answer 401, as the backend does
	// for a revoked installation's token. A new token clears it.
	TokenRevoked bool
	Rotations    int
	// Status overrides the status code for a path with an empty body, e.g. a
	// bare 401 from a proxy; use TokenRevoked for the backend's revocation.
	Status  map[string]int
	Respond IngestResponder
	// WebOrigin, when set, is answered by GET /api/companion/me.
	WebOrigin string
	// Stall holds each request to a path until its channel closes or the
	// client gives up, like a server that accepts and never answers.
	Stall map[string]chan struct{}

	// AgentKey is the installation's agents key on the server, "" for none;
	// AgentKeyMints and AgentKeyDeletes count the device's calls.
	AgentKey        string
	AgentKeyMints   int
	AgentKeyDeletes int
	// Boards is the /api/companion/boards document.
	Boards map[string]any

	// DeletedSessions are native session ids the owner deleted, answered as
	// a server from before history cutoffs did: every record is dropped.
	DeletedSessions map[string]bool
	// DeletedThrough are native session ids whose history the owner deleted
	// through a cutoff: records captured by then are dropped, and every
	// answer about the session reports the cutoff.
	DeletedThrough map[string]time.Time

	// PairingAnswers scripts the pairing token endpoint, one answer per poll
	// (the last repeats): an RFC 8628 error code, or "granted".
	PairingAnswers []string
	PairingPolls   int
	PairingStarts  []map[string]any
	// GrantTokens maps extra device tokens to the installation each one
	// authenticates, e.g. two grants racing to connect one device; revoking
	// with such a token revokes only its installation.
	GrantTokens map[string]string

	// deviceInstallation is the installation DeviceToken was last issued
	// to; GET /policy answers for it, as the backend does.
	deviceInstallation string

	// Rich capture. Policy.RichCapture is the offer the policy answers.
	// Capabilities records each policy request's capabilities header.
	Capabilities []string
	// RejectRich rejects every record that carries rich members with this
	// reason, as a server from before rich capture does ("invalid").
	RejectRich string
	// ChunkBytes is the upload slots' chunk size.
	ChunkBytes int64
	// Contents are the content items stored, by key.
	Contents map[string]*StoredContent
	// ContentOutcome forces the ack members answered for a content key.
	ContentOutcome map[string]map[string]any
	// UploadErrors make a content's chunk PUTs and finalize fail, by
	// content id; GET still answers the row's state.
	UploadErrors map[string]UploadError
	// ChunkChecksumFailures answers that many chunk PUTs of a content
	// chunk_checksum_mismatch, as a body damaged in transit would.
	ChunkChecksumFailures map[string]int
	// FinalizeFailures answers that many finalizes of a content
	// body_checksum_mismatch; the third failure records the upload failed.
	FinalizeFailures map[string]int
	// RejectRichStatus refuses a heartbeat carrying rich_capture, as a
	// server from before rich capture does (extra=forbid).
	RejectRichStatus bool
	ChunkPuts        int
	// Rejections are every record rejection answered, in order.
	Rejections []map[string]string
	// receipts hold each acknowledged record's bytes digest, by capture id.
	receipts     map[string]string
	contentCount int

	Registrations []map[string]string
	Resolutions   []map[string]string
	Heartbeats    []map[string]any
	Batches       [][]json.RawMessage
	Revocations   int
}

func New(t *testing.T) *Server {
	t.Helper()
	server := &Server{
		Policy:                policy.Policy{Installation: policy.Installation{ID: "installation", AutoMatchRepos: true, EnabledAgents: []string{"claude_code"}}},
		Resolvable:            map[string]policy.Mapping{},
		MappingRefusals:       map[string]int{},
		GrantTokens:           map[string]string{},
		Installed:             map[string]bool{},
		Revoked:               map[string]bool{},
		Status:                map[string]int{},
		Stall:                 map[string]chan struct{}{},
		DeletedSessions:       map[string]bool{},
		DeletedThrough:        map[string]time.Time{},
		ChunkBytes:            4 << 20,
		Contents:              map[string]*StoredContent{},
		ContentOutcome:        map[string]map[string]any{},
		UploadErrors:          map[string]UploadError{},
		ChunkChecksumFailures: map[string]int{},
		FinalizeFailures:      map[string]int{},
		receipts:              map[string]string{},
	}
	server.Server = httptest.NewServer(http.HandlerFunc(server.handle))
	t.Cleanup(server.Close)
	return server
}

// RevokeAll revokes every installation, as the owner revoking this device
// from Backplane does.
func (s *Server) RevokeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.Installed {
		s.Revoked[id] = true
	}
	s.TokenRevoked = true
}

func (s *Server) Lock()   { s.mu.Lock() }
func (s *Server) Unlock() { s.mu.Unlock() }

// Records returns every record the server received, in order.
func (s *Server) Records() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var records []map[string]any
	for _, batch := range s.Batches {
		for _, raw := range batch {
			var record map[string]any
			json.Unmarshal(raw, &record)
			records = append(records, record)
		}
	}
	return records
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	gate := s.Stall[r.URL.Path]
	s.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-r.Context().Done():
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if status := s.Status[r.URL.Path]; status != 0 {
		w.WriteHeader(status)
		return
	}
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/me/companion/installations":
		if token != APIKey {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var request map[string]string
		json.Unmarshal(body, &request)
		s.Registrations = append(s.Registrations, request)
		id := request["installation_id"]
		if s.Installed[id] {
			// The token is shown only on first create.
			writeJSON(w, http.StatusOK, map[string]any{"installation_id": id, "device_token": nil})
			return
		}
		s.Installed[id] = true
		s.TokenRevoked = false
		s.deviceInstallation = id
		writeJSON(w, http.StatusCreated, map[string]any{"installation_id": id, "device_token": DeviceToken, "future_field": true})
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/me/companion/installations/") && strings.HasSuffix(r.URL.Path, "/rotate"):
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/me/companion/installations/"), "/rotate")
		switch {
		case token != APIKey:
			w.WriteHeader(http.StatusUnauthorized)
		case s.Revoked[id]:
			writeJSON(w, http.StatusConflict, map[string]any{"detail": "installation_revoked"})
		case !s.Installed[id]:
			w.WriteHeader(http.StatusNotFound)
		default:
			s.Rotations++
			s.TokenRevoked = false
			s.deviceInstallation = id
			writeJSON(w, http.StatusOK, map[string]any{"installation_id": id, "device_token": DeviceToken, "token_prefix": DeviceToken[:8]})
		}
	case r.Method == http.MethodPost && r.URL.Path == "/api/companion/pairing":
		var request map[string]any
		json.Unmarshal(body, &request)
		s.PairingStarts = append(s.PairingStarts, request)
		writeJSON(w, http.StatusOK, map[string]any{
			"device_code": "dc_synthetic", "user_code": "BCDF-GHJK",
			"verification_uri":          s.URL + "/companion/pair",
			"verification_uri_complete": s.URL + "/companion/pair#code=BCDF-GHJK",
			"interval":                  5, "expires_in": 600,
		})
	case r.Method == http.MethodPost && r.URL.Path == "/api/companion/pairing/token":
		s.PairingPolls++
		answer := "authorization_pending"
		if len(s.PairingAnswers) > 0 {
			answer = s.PairingAnswers[min(s.PairingPolls, len(s.PairingAnswers))-1]
		}
		if answer != "granted" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"detail": answer, "error_code": answer})
			return
		}
		s.Installed[PairedInstallationID] = true
		s.TokenRevoked = false
		s.deviceInstallation = PairedInstallationID
		writeJSON(w, http.StatusOK, map[string]any{"installation_id": PairedInstallationID, "device_token": DeviceToken})
	case s.GrantTokens[token] != "":
		s.handleGrant(w, r, token)
	case token != DeviceToken || s.TokenRevoked:
		writeJSON(w, http.StatusUnauthorized, map[string]any{"detail": "Invalid or revoked device token", "error_code": "invalid_device_token"})
	case r.Method == http.MethodGet && r.URL.Path == "/api/companion/me" && s.WebOrigin != "":
		writeJSON(w, http.StatusOK, map[string]any{"user": map[string]any{"email": "owner@example.test", "display_name": nil}, "installation": map[string]any{"id": s.deviceInstallation, "name": "device"}, "web_origin": s.WebOrigin})
	case r.Method == http.MethodGet && r.URL.Path == "/api/companion/policy":
		s.Capabilities = append(s.Capabilities, r.Header.Get(policy.CapabilitiesHeader))
		writeJSON(w, http.StatusOK, s.policyFor(s.deviceInstallation))
	case strings.HasPrefix(r.URL.Path, "/api/companion/contents/"):
		s.handleContent(w, r, body)
	case r.Method == http.MethodPost && r.URL.Path == "/api/companion/mappings":
		var request map[string]string
		json.Unmarshal(body, &request)
		s.Resolutions = append(s.Resolutions, request)
		if status := s.MappingRefusals[request["repo_url"]]; status != 0 {
			reason := map[int]string{409: "ambiguous_repo", 403: "auto_match_disabled", 422: "invalid_repo_url"}[status]
			writeJSON(w, status, map[string]any{"detail": reason})
			return
		}
		for _, existing := range s.Policy.Mappings {
			if existing.Origin == "auto_repo" && existing.RepoURLNormalized == request["repo_url"] {
				writeJSON(w, http.StatusOK, existing)
				return
			}
		}
		mapping, ok := s.Resolvable[request["repo_url"]]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		mapping.RepoURLNormalized, mapping.Origin = request["repo_url"], "auto_repo"
		s.Policy.Mappings = append(s.Policy.Mappings, mapping)
		writeJSON(w, http.StatusCreated, mapping)
	case r.Method == http.MethodDelete && r.URL.Path == "/api/companion/installation":
		s.Revocations++
		for id := range s.Installed {
			s.Revoked[id] = true
		}
		s.TokenRevoked = true
		s.AgentKey = ""
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == "/api/companion/agent-key":
		s.agentKey(w, r.Method)
	case r.Method == http.MethodGet && r.URL.Path == "/api/companion/boards":
		boards := s.Boards
		if boards == nil {
			boards = map[string]any{"workspaces": []any{}}
		}
		writeJSON(w, http.StatusOK, boards)
	case r.Method == http.MethodPost && r.URL.Path == "/api/companion/status":
		var report map[string]any
		json.Unmarshal(body, &report)
		s.Heartbeats = append(s.Heartbeats, report)
		if _, rich := report["rich_capture"]; rich && s.RejectRichStatus {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": "extra_forbidden"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"recorded": true})
	case r.Method == http.MethodPost && r.URL.Path == "/api/companion/ingest":
		s.ingest(w, body)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// agentKey mints, reports and deletes the agents key as contract v1.4 §C
// describes; a mint replaces the previous key.
func (s *Server) agentKey(w http.ResponseWriter, method string) {
	switch method {
	case http.MethodPost:
		s.AgentKeyMints++
		s.AgentKey = fmt.Sprintf("vlr_synthetic_agent_key_%04d", s.AgentKeyMints)
		writeJSON(w, http.StatusCreated, map[string]any{"id": fmt.Sprintf("agent-key-%d", s.AgentKeyMints), "name": "Companion · test · agents", "key_prefix": s.AgentKey[:8], "key": s.AgentKey, "created_at": "2026-09-30T10:00:00Z"})
	case http.MethodGet:
		if s.AgentKey == "" {
			writeJSON(w, http.StatusNotFound, map[string]any{"error_code": "agent_key_missing"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": fmt.Sprintf("agent-key-%d", s.AgentKeyMints), "name": "Companion · test · agents", "key_prefix": s.AgentKey[:8], "created_at": "2026-09-30T10:00:00Z", "last_used_at": nil})
	case http.MethodDelete:
		s.AgentKeyDeletes++
		s.AgentKey = ""
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleGrant(w http.ResponseWriter, r *http.Request, token string) {
	id := s.GrantTokens[token]
	switch {
	case s.Revoked[id]:
		writeJSON(w, http.StatusUnauthorized, map[string]any{"detail": "Invalid or revoked device token", "error_code": "invalid_device_token"})
	case r.Method == http.MethodGet && r.URL.Path == "/api/companion/policy":
		writeJSON(w, http.StatusOK, s.policyFor(id))
	case r.Method == http.MethodDelete && r.URL.Path == "/api/companion/installation":
		s.Revocations++
		s.Revoked[id] = true
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && r.URL.Path == "/api/companion/status":
		writeJSON(w, http.StatusOK, map[string]any{"recorded": true})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// policyFor is Policy as installationID's device sees it; with no
// installation issued yet (package tests that skip registration) it is
// Policy unchanged.
func (s *Server) policyFor(installationID string) policy.Policy {
	answer := s.Policy
	if installationID != "" {
		answer.Installation.ID = installationID
	}
	return answer
}

func (s *Server) ingest(w http.ResponseWriter, body []byte) {
	var batch struct {
		Records []json.RawMessage `json:"records"`
	}
	if err := json.Unmarshal(body, &batch); err != nil {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	s.Batches = append(s.Batches, batch.Records)
	ids := make([]string, 0, len(batch.Records))
	acknowledged := []string{}
	rejected := []map[string]string{}
	dropped := []map[string]string{}
	historyDeleted := []map[string]any{}
	contents := []map[string]any{}
	for _, raw := range batch.Records {
		var record struct {
			CaptureID       string    `json:"capture_id"`
			MappingID       string    `json:"mapping_id"`
			Harness         string    `json:"harness"`
			NativeSessionID string    `json:"native_session_id"`
			CapturedAt      time.Time `json:"captured_at"`
		}
		json.Unmarshal(raw, &record)
		var rich richRecord
		json.Unmarshal(raw, &rich)
		ids = append(ids, record.CaptureID)
		reject := func(reason string) {
			rejection := map[string]string{"capture_id": record.CaptureID, "reason": reason}
			rejected = append(rejected, rejection)
			s.Rejections = append(s.Rejections, rejection)
		}
		if s.RejectRich != "" && (rich.Contents != nil || rich.CaptureGeneration != nil) {
			reject(s.RejectRich)
			continue
		}
		// The ingest receipt: a replay of the same bytes is acknowledged
		// again with its content acks, other bytes are a conflict.
		sum := sha256.Sum256(raw)
		if receipt, known := s.receipts[record.CaptureID]; known && receipt != hex.EncodeToString(sum[:]) {
			reject("conflict")
			continue
		}
		s.receipts[record.CaptureID] = hex.EncodeToString(sum[:])
		acknowledged = append(acknowledged, record.CaptureID)
		through, cutOff := s.DeletedThrough[record.NativeSessionID]
		isDropped := s.DeletedSessions[record.NativeSessionID] || cutOff && !record.CapturedAt.After(through)
		if isDropped {
			dropped = append(dropped, map[string]string{"capture_id": record.CaptureID, "reason": "session_deleted"})
		}
		if cutOff {
			historyDeleted = append(historyDeleted, map[string]any{"mapping_id": record.MappingID, "harness": record.Harness, "native_session_id": record.NativeSessionID, "deleted_through": through, "reason": "owner"})
		}
		var cutoff *time.Time
		if cutOff {
			cutoff = &through
		}
		contents = append(contents, s.contentAcks(rich, isDropped, cutoff)...)
	}
	if s.Respond != nil {
		status, response := s.Respond(ids)
		writeJSON(w, status, response)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"acknowledged": acknowledged, "rejected": rejected, "dropped": dropped, "history_deleted": historyDeleted, "contents": contents})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if raw, ok := value.(json.RawMessage); ok {
		w.Write(raw)
		return
	}
	json.NewEncoder(w).Encode(value)
}
