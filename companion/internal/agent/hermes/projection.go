// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const pluginSchema = "backplane.hermes.v1"

var (
	localSurfaces = map[string]bool{"cli": true, "tui": true, "desktop": true, "acp": true}
	toolStatuses  = map[string]bool{"ok": true, "error": true, "blocked": true, "cancelled": true}
	// denyingChoices all reach Beacon as deny: the pinned Beacon reports
	// smart_deny as allowed, and a timed-out approval did not run either.
	denyingChoices = map[string]bool{"deny": true, "smart_deny": true, "timeout": true}
)

// nativeID is the backend's NativeId. Hermes v0.22.4 session ids fit it: the
// gateway's `local-<64 hex>`, `YYYYMMDD_HHMMSS_<hex>` from new_session_id and
// ACP's uuids.
var nativeID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$`)

// nativeRef admits provider tool-call ids (OpenAI's `<call id>|<item id>`
// runs to hundreds of characters with base64 characters) and Hermes turn ids
// (`<session id>:<session id>:<8 hex>`), with Pi's alphabet and bound.
var nativeRef = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:@/+=|-]*$`)

const maxNativeRefBytes = 4096

// maxUploadedCallIDBytes is the longest tool-call id the backend keeps: it
// stores one only as a NativeId (backend/app/core/harness.py), so a longer id
// would be dropped there and its call lost from the session's counts.
const maxUploadedCallIDBytes = 200

// endReason is Hermes' own vocabulary for why a session ended (cli_close,
// new_session, session_boundary, ...; gateway/session_controls.py _END_REASON):
// a lifecycle token Hermes names, never text a person typed.
var endReason = regexp.MustCompile(`^[a-z][a-z_]{0,31}$`)

var (
	toolName  = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
	modelName = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}$`)
)

func validNativeRef(id string) bool { return len(id) <= maxNativeRefBytes && nativeRef.MatchString(id) }

// hermesMintedCallID is the id Hermes mints for a provider tool call that
// came without one: `call_` + 12 hex of sha256(tool name:arguments:index)
// (agent/message_sanitization.py deterministic_call_id), so hashing a guessed
// command confirms it. Hermes renames a repeat `<id>_d<n>`
// (uniquify_tool_call_ids), and renames it again when a provider echoes a
// renamed id. Responses bridges spell one call `<call id>|<item id>`, whose
// item half can repeat the same 12 hex. When the call half is minted the whole
// id is replaced before anything is written.
var hermesMintedCallID = regexp.MustCompile(`^call_[0-9a-f]{12}(?:_d[0-9]+)*$`)

func isHermesMintedCallID(id string) bool {
	callHalf, _, _ := strings.Cut(id, "|")
	return hermesMintedCallID.MatchString(callHalf)
}

// callIDOfFiring stands in for a minted call id, or one longer than the
// backend keeps. It is derived from the record's identity alone, so a
// re-delivery keeps it and the same command in a later turn gets another.
func callIDOfFiring(sessionID, turnID, observedAt string) string {
	sum := sha256.Sum256([]byte("hermes-synthesized-call\x00" + sessionID + "\x00" + turnID + "\x00" + observedAt))
	return "hermes-" + hex.EncodeToString(sum[:])[:24]
}

// projectHook keeps the allowlisted members of a validated hook. Member names
// stay clear of privacy's content members, so nothing kept is ever digested.
func projectHook(observation agent.Observation, hook, extra map[string]any) map[string]any {
	projected := map[string]any{
		"hook_event_name": observation.Event,
		"session_id":      observation.NativeSessionID,
		"cwd":             observation.Cwd,
		// Hermes' shell-hook envelope, which Beacon parses: tool members are
		// null off tool calls, and tool_input never carries the arguments.
		"tool_input": nil,
		"tool_name":  nil,
	}
	if observation.Event == "post_tool_call" {
		delete(projected, "tool_name")
		if name, _ := hook["tool_name"].(string); toolName.MatchString(name) {
			projected["tool_name"] = name
		}
	}
	if observation.NativeToolCallID != "" {
		projected["tool_call_id"] = observation.NativeToolCallID
	}
	kept := map[string]any{"platform": extra["platform"]}
	if schema, _ := extra["plugin_schema"].(string); schema == pluginSchema {
		kept["plugin_schema"] = schema
	}
	if observedAt, _ := extra["observed_at"].(string); isRFC3339(observedAt) {
		kept["observed_at"] = observedAt
	}
	if turnID, _ := extra["turn_id"].(string); validNativeRef(turnID) {
		kept["turn_id"] = turnID
	}
	if status, _ := extra["status"].(string); toolStatuses[status] {
		kept["status"] = status
	}
	if duration, ok := extra["duration_ms"].(json.Number); ok {
		if milliseconds, err := strconv.ParseInt(string(duration), 10, 64); err == nil && milliseconds >= 0 {
			kept["duration_ms"] = json.Number(strconv.FormatInt(milliseconds, 10))
		}
	}
	switch observation.Event {
	case "on_session_start":
		if model, _ := extra["model"].(string); modelName.MatchString(model) {
			kept["model"] = model
		}
	case "post_approval_response":
		kept["choice"] = "deny"
	case "on_session_finalize":
		if reason, _ := extra["reason"].(string); endReason.MatchString(reason) {
			kept["reason"] = reason
		}
	}
	projected["extra"] = kept
	return projected
}

func isRFC3339(text string) bool {
	_, err := time.Parse(time.RFC3339, text)
	return err == nil
}

// CaptureKey names an observation by its identity alone (its call id, else
// its turn and when Hermes observed it), never by its content: a re-delivery
// is the same capture, and the same identity re-sent with other content is
// too, which the server refuses as a conflict instead of overwriting the first
// copy.
func (Hermes) CaptureKey(_ agent.Observation, payload map[string]any) (string, bool) {
	extra, _ := payload["extra"].(map[string]any)
	schema, _ := extra["plugin_schema"].(string)
	event, _ := payload["hook_event_name"].(string)
	sessionID, _ := payload["session_id"].(string)
	discriminator, _ := payload["tool_call_id"].(string)
	// Without a call id, when Hermes observed the firing names it beside its
	// turn, if any: one turn can deny twice, a reopened session is finalized
	// again, and a start re-fires after a model switch.
	if discriminator == "" {
		turnID, _ := extra["turn_id"].(string)
		discriminator, _ = extra["observed_at"].(string)
		if turnID != "" {
			discriminator = turnID + "\x00" + discriminator
		}
	}
	sum := sha256.Sum256([]byte(strings.Join([]string{"hermes", schema, event, sessionID, discriminator}, "\x00")))
	return hex.EncodeToString(sum[:]), true
}

// allowlist names the members kept at each level; a nil child is a scalar leaf.
type allowlist map[string]allowlist

var eventAllowlist = allowlist{
	"schema_version": nil,
	"timestamp":      nil,
	"event":          {"action": nil, "category": nil, "kind": nil, "fidelity": nil},
	"harness":        {"name": nil},
	"session":        {"id": nil, "working_directory": nil},
	"tool":           {"name": nil},
	"mcp":            {"server": nil, "tool": nil, "method": {"name": nil}},
	"gen_ai":         {"operation": {"name": nil}, "tool": {"name": nil, "call": {"id": nil}}},
	"approval":       {"decision": nil},
}

// eventIDNamespace is fixed for good: changing it renames every Hermes event
// already uploaded.
var eventIDNamespace = [16]byte{0xac, 0x46, 0x2e, 0xcd, 0xa8, 0xdd, 0x40, 0x95, 0xb0, 0xa1, 0x90, 0x98, 0xd2, 0xbb, 0x66, 0xe2}

var errForeignSession = errors.New("hermes_event_of_another_session")

// ProjectEvents keeps the allowlisted members of Beacon's events. Each event
// is named by the capture key and its position, and timed when Hermes
// observed it, so the same observation yields the same bytes on every run.
// Beacon labels every Hermes event hook-collected; the companion reached it
// through the observer plugin.
func (h Hermes) ProjectEvents(observation agent.Observation, payload map[string]any, events []json.RawMessage) ([]json.RawMessage, error) {
	key, named := h.CaptureKey(observation, payload)
	if !named {
		return nil, agent.ErrInvalidHook
	}
	extra, _ := payload["extra"].(map[string]any)
	projected := make([]json.RawMessage, len(events))
	for index, line := range events {
		var event map[string]any
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&event); err != nil {
			return nil, err
		}
		session, _ := event["session"].(map[string]any)
		if sessionID, _ := session["id"].(string); sessionID != observation.NativeSessionID {
			return nil, errForeignSession
		}
		kept := keep(event, eventAllowlist)
		if observedAt, ok := extra["observed_at"].(string); ok {
			kept["timestamp"] = observedAt
		}
		childObject(kept, "event")["id"] = nameBasedUUID(eventIDNamespace, key+":"+strconv.Itoa(index))
		childObject(kept, "harness")["collection_method"] = string(h.Ingress())
		if status, ok := extra["status"].(string); ok {
			kept["status"] = status
		}
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(kept); err != nil {
			return nil, err
		}
		projected[index] = json.RawMessage(bytes.TrimSpace(buffer.Bytes()))
	}
	return projected, nil
}

// childObject returns the object parent holds under name, adding it when absent.
func childObject(parent map[string]any, name string) map[string]any {
	object, _ := parent[name].(map[string]any)
	if object == nil {
		object = map[string]any{}
		parent[name] = object
	}
	return object
}

func keep(object map[string]any, allowed allowlist) map[string]any {
	kept := map[string]any{}
	for name, children := range allowed {
		value, present := object[name]
		if !present {
			continue
		}
		if children == nil {
			switch value.(type) {
			case string, bool, json.Number:
				kept[name] = value
			}
			continue
		}
		if nested, isObject := value.(map[string]any); isObject {
			if members := keep(nested, children); len(members) > 0 {
				kept[name] = members
			}
		}
	}
	return kept
}

// nameBasedUUID is RFC 9562's name-based UUID, which is defined over SHA-1.
func nameBasedUUID(namespace [16]byte, name string) string {
	hash := sha1.New()
	hash.Write(namespace[:])
	hash.Write([]byte(name))
	var id [16]byte
	copy(id[:], hash.Sum(nil))
	id[6] = id[6]&0x0f | 0x50
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:])
}
