// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplinktest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Rich capture's side of the fake, after RC-02 (contracts/rich-capture):
// content acks at ingest, chunked uploads and their finalize.

// StoredContent is one content item as the server keeps it.
type StoredContent struct {
	ID         string
	Key        string
	CaptureID  string
	Generation string
	Delivery   string
	Coverage   string
	// CoverageReason is the declared reason, nil without one.
	CoverageReason *string
	SHA256         string
	ByteCount      int64
	// State is pending, available or recorded.
	State      string
	ChunkCount int
	Chunks     map[int][]byte
	// Body is the published body (inline, or composed at finalize).
	Body []byte
	// Finalizes counts finalize calls, failed ones included.
	Finalizes       int
	failedFinalizes int
}

func allChunks(count int) []int {
	chunks := make([]int, count)
	for index := range chunks {
		chunks[index] = index
	}
	return chunks
}

// UploadError makes every upload call for one content answer an error.
type UploadError struct {
	Status int
	Code   string
}

type contentDeclaration struct {
	ContentKey     string    `json:"content_key"`
	OccurredAt     time.Time `json:"occurred_at"`
	Coverage       string    `json:"coverage"`
	CoverageReason *string   `json:"coverage_reason"`
	Delivery       string    `json:"delivery"`
	ByteCount      *int64    `json:"byte_count"`
	SHA256         *string   `json:"sha256"`
	InlineText     *string   `json:"inline_text"`
}

type richRecord struct {
	CaptureID         string               `json:"capture_id"`
	Contents          []contentDeclaration `json:"contents"`
	CaptureGeneration *struct {
		ID string `json:"id"`
	} `json:"capture_generation"`
}

func (s *Server) contentByID(id string) *StoredContent {
	for _, content := range s.Contents {
		if content.ID == id {
			return content
		}
	}
	return nil
}

// contentAcks answers each declaration of an acknowledged record, as RC-02's
// decision order does for the outcomes the fake models: dropped (the record,
// or a declaration at or before the history cutoff), stored (replayed),
// conflict, available inline or bodiless, upload_required.
func (s *Server) contentAcks(record richRecord, dropped bool, cutoff *time.Time) []map[string]any {
	var acks []map[string]any
	for _, declared := range record.Contents {
		ack := map[string]any{"capture_id": record.CaptureID, "content_key": declared.ContentKey}
		acks = append(acks, ack)
		if dropped || cutoff != nil && !declared.OccurredAt.After(*cutoff) {
			ack["outcome"] = "dropped"
			continue
		}
		if forced := s.ContentOutcome[declared.ContentKey]; forced != nil {
			for key, value := range forced {
				ack[key] = value
			}
			continue
		}
		size, digest := int64(0), ""
		if declared.ByteCount != nil {
			size = *declared.ByteCount
		}
		if declared.SHA256 != nil {
			digest = *declared.SHA256
		}
		stored := s.Contents[declared.ContentKey]
		if stored != nil && (stored.SHA256 != digest || stored.ByteCount != size || stored.Coverage != declared.Coverage || stored.Delivery != declared.Delivery) {
			ack["outcome"], ack["rejection"] = "rejected", "conflict"
			continue
		}
		if stored == nil {
			s.contentCount++
			stored = &StoredContent{
				ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", s.contentCount), Key: declared.ContentKey, CaptureID: record.CaptureID,
				Delivery: declared.Delivery, Coverage: declared.Coverage, CoverageReason: declared.CoverageReason, SHA256: digest, ByteCount: size, State: "available", Chunks: map[int][]byte{},
			}
			if record.CaptureGeneration != nil {
				stored.Generation = record.CaptureGeneration.ID
			}
			switch declared.Delivery {
			case "inline":
				stored.Body = []byte(*declared.InlineText)
			case "upload":
				stored.State = "pending"
				stored.ChunkCount = int((size + s.ChunkBytes - 1) / s.ChunkBytes)
			}
			s.Contents[declared.ContentKey] = stored
		}
		ack["content_id"] = stored.ID
		switch stored.State {
		case "pending":
			ack["outcome"], ack["upload"] = "upload_required", s.slotOf(stored)
		case "recorded":
			ack["outcome"], ack["coverage"], ack["coverage_reason"] = "recorded", "collection_failed", "upload_failed"
		default:
			ack["outcome"] = "available"
		}
	}
	return acks
}

func (s *Server) slotOf(content *StoredContent) map[string]any {
	received := []int{}
	for index := range content.Chunks {
		received = append(received, index)
	}
	slices.Sort(received)
	return map[string]any{"chunk_bytes": s.ChunkBytes, "chunk_count": content.ChunkCount, "received_chunks": received, "expires_at": time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (s *Server) stateOf(content *StoredContent) map[string]any {
	state := map[string]any{"content_id": content.ID, "state": content.State}
	switch content.State {
	case "pending":
		state["coverage"], state["coverage_reason"], state["upload"] = "not_yet_uploaded", "upload_pending", s.slotOf(content)
	case "recorded":
		state["coverage"], state["coverage_reason"] = "collection_failed", "upload_failed"
	default:
		state["coverage"], state["coverage_reason"] = content.Coverage, content.CoverageReason
	}
	return state
}

func contentError(w http.ResponseWriter, status int, code string, params map[string]any) {
	if params == nil {
		params = map[string]any{}
	}
	writeJSON(w, status, map[string]any{"detail": code, "error_code": code, "error_params": params, "context": nil})
}

// handleContent serves PUT …/chunks/{index}, POST …/finalize and GET of
// /api/companion/contents/{id}.
func (s *Server) handleContent(w http.ResponseWriter, r *http.Request, body []byte) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/companion/contents/")
	parts := strings.Split(rest, "/")
	content := s.contentByID(parts[0])
	if failure, failing := s.UploadErrors[parts[0]]; failing && r.Method != http.MethodGet {
		contentError(w, failure.Status, failure.Code, nil)
		return
	}
	if content == nil {
		contentError(w, http.StatusNotFound, "content_not_found", nil)
		return
	}
	switch {
	case r.Method == http.MethodPut && len(parts) == 3 && parts[1] == "chunks":
		s.ChunkPuts++
		index, err := strconv.Atoi(parts[2])
		if err != nil || index < 0 || index >= max(content.ChunkCount, 1) {
			contentError(w, http.StatusUnprocessableEntity, "chunk_out_of_range", nil)
			return
		}
		sum := sha256.Sum256(body)
		if r.Header.Get("Backplane-Chunk-SHA256") != hex.EncodeToString(sum[:]) || s.ChunkChecksumFailures[content.ID] > 0 {
			s.ChunkChecksumFailures[content.ID]--
			contentError(w, http.StatusUnprocessableEntity, "chunk_checksum_mismatch", nil)
			return
		}
		expected := s.ChunkBytes
		if index == content.ChunkCount-1 {
			expected = content.ByteCount - s.ChunkBytes*int64(index)
		}
		if int64(len(body)) != expected || r.Header.Get("Content-Type") != "application/octet-stream" {
			contentError(w, http.StatusUnprocessableEntity, "chunk_size_mismatch", map[string]any{"expected_bytes": expected, "received_bytes": len(body)})
			return
		}
		// Amendment 3: a settled row takes the same bytes again as complete.
		if start := s.ChunkBytes * int64(index); content.State == "available" && content.Delivery == "upload" && start+int64(len(body)) <= int64(len(content.Body)) && bytes.Equal(content.Body[start:start+int64(len(body))], body) {
			writeJSON(w, http.StatusOK, map[string]any{"content_id": content.ID, "index": index, "received_chunks": allChunks(content.ChunkCount), "chunk_count": content.ChunkCount, "complete": true})
			return
		}
		if content.State != "pending" {
			contentError(w, http.StatusConflict, "chunk_conflict", nil)
			return
		}
		content.Chunks[index] = bytes.Clone(body)
		slot := s.slotOf(content)
		writeJSON(w, http.StatusOK, map[string]any{"content_id": content.ID, "index": index, "received_chunks": slot["received_chunks"], "chunk_count": content.ChunkCount, "complete": len(content.Chunks) == content.ChunkCount})
	case r.Method == http.MethodPost && len(parts) == 2 && parts[1] == "finalize":
		content.Finalizes++
		var request struct {
			ByteCount int64  `json:"byte_count"`
			SHA256    string `json:"sha256"`
		}
		json.Unmarshal(body, &request)
		switch content.State {
		case "available":
			writeJSON(w, http.StatusOK, s.stateOf(content))
			return
		case "recorded":
			contentError(w, http.StatusConflict, "chunk_conflict", nil)
			return
		}
		var missing []int
		var composed []byte
		for index := range content.ChunkCount {
			chunk, ok := content.Chunks[index]
			if !ok {
				missing = append(missing, index)
			}
			composed = append(composed, chunk...)
		}
		if len(missing) > 0 {
			contentError(w, http.StatusConflict, "upload_incomplete", map[string]any{"missing_chunks": missing})
			return
		}
		sum := sha256.Sum256(composed)
		damaged := s.FinalizeFailures[content.ID] > 0
		if damaged || int64(len(composed)) != content.ByteCount || hex.EncodeToString(sum[:]) != content.SHA256 || request.SHA256 != content.SHA256 || request.ByteCount != content.ByteCount {
			s.FinalizeFailures[content.ID]--
			content.Chunks = map[int][]byte{}
			content.failedFinalizes++
			// Amendment 7: the third failure records the upload failed.
			if content.failedFinalizes >= 3 {
				content.State = "recorded"
			}
			contentError(w, http.StatusUnprocessableEntity, "body_checksum_mismatch", map[string]any{"attempts": content.failedFinalizes})
			return
		}
		content.Body, content.State = composed, "available"
		writeJSON(w, http.StatusOK, s.stateOf(content))
	case r.Method == http.MethodGet && len(parts) == 1:
		writeJSON(w, http.StatusOK, s.stateOf(content))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// Body is the published body of a content key, nil until it is available.
func (s *Server) Body(contentKey string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if content := s.Contents[contentKey]; content != nil && content.State == "available" {
		return content.Body
	}
	return nil
}

// Declarations are every content declaration the server received, in order.
func (s *Server) Declarations() []map[string]any {
	var declarations []map[string]any
	for _, record := range s.Records() {
		contents, _ := record["contents"].([]any)
		for _, content := range contents {
			declarations = append(declarations, content.(map[string]any))
		}
	}
	return declarations
}
