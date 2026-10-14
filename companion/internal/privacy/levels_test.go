// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy_test

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

// levelsFixture is the one table of what each content level sends. The
// desktop's privacy copy is tested against the same file, so the words a
// person reads and the filter on the device cannot drift apart.
const levelsFixture = "testdata/levels.golden.json"

type levelsTable struct {
	Levels     []privacy.ContentLevel `json:"levels"`
	Treatments map[string]string      `json:"treatments"`
	Categories []struct {
		ID     string                          `json:"id"`
		Label  string                          `json:"label"`
		Sends  map[privacy.ContentLevel]string `json:"sends"`
		Probes []levelProbe                    `json:"probes"`
	} `json:"categories"`
}

type levelProbe struct {
	Kind             string         `json:"kind"`
	Agent            string         `json:"agent"`
	Event            string         `json:"event"`
	Path             string         `json:"path"`
	Payload          map[string]any `json:"payload"`
	Normalized       map[string]any `json:"normalized"`
	Root             string         `json:"root"`
	WorkingDirectory string         `json:"working_directory"`
	NameOnly         string         `json:"name_only"`
	ProjectRelative  string         `json:"project_relative"`
}

func readLevelsTable(t *testing.T) levelsTable {
	t.Helper()
	data, err := os.ReadFile(levelsFixture)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	var table levelsTable
	if err := decoder.Decode(&table); err != nil {
		t.Fatal(err)
	}
	return table
}

func TestLevelsFixture_CoversEveryLevelWithAKnownTreatment(t *testing.T) {
	table := readLevelsTable(t)
	if !reflect.DeepEqual(table.Levels, []privacy.ContentLevel{privacy.Metadata, privacy.Standard, privacy.Full, privacy.Rich}) {
		t.Fatalf("levels = %v", table.Levels)
	}
	for _, category := range table.Categories {
		if len(category.Probes) == 0 {
			t.Errorf("%s has no probe, so nothing checks it", category.ID)
		}
		for _, level := range table.Levels {
			if _, known := table.Treatments[category.Sends[level]]; !known {
				t.Errorf("%s at %s has treatment %q", category.ID, level, category.Sends[level])
			}
		}
	}
}

func TestLevelsFixture_DeviceFilterSendsWhatTheTableSays(t *testing.T) {
	table := readLevelsTable(t)
	for _, category := range table.Categories {
		for _, level := range table.Levels {
			treatment := category.Sends[level]
			for index, probe := range category.Probes {
				name := category.ID + "/" + string(level) + "/" + strconv.Itoa(index)
				t.Run(name, func(t *testing.T) {
					switch probe.Kind {
					case "working_directory":
						checkWorkingDirectory(t, probe, level, treatment)
					case "normalized":
						checkNormalizedMember(t, probe, level, treatment)
					default:
						checkPayloadMember(t, probe, level, treatment)
					}
				})
			}
		}
	}
}

var adapters = map[string]agent.Agent{claudecode.ID: claudecode.New(), pi.ID: pi.New()}

// deviceReduce applies level to a hook payload the way it travels: the shim
// retains it (shim.retain) and the daemon applies the mapping's current
// level again before handing it to Beacon (daemon.normalize).
func deviceReduce(adapter agent.Agent, event string, payload map[string]any, level privacy.ContentLevel) map[string]any {
	toolOutput := adapter.ToolOutput(event)
	payload = privacy.ReduceEditContent(payload, adapter.ID(), level)
	clean, _ := privacy.SanitizeFor(privacy.ReduceToolOutput(payload, toolOutput, level), toolOutput, level)
	retained := privacy.ApplyContentLevel(clean, level)
	return privacy.ApplyContentLevel(privacy.ReduceToolOutput(privacy.ReduceEditContent(retained, adapter.ID(), level), toolOutput, level), level)
}

func checkPayloadMember(t *testing.T, probe levelProbe, level privacy.ContentLevel, treatment string) {
	adapter, known := adapters[probe.Agent]
	if !known {
		t.Fatalf("no adapter %q", probe.Agent)
	}
	assertTreatment(t, probe.Payload, deviceReduce(adapter, probe.Event, probe.Payload, level), probe.Path, treatment)
}

// checkNormalizedMember probes an event as Beacon normalized it, through the
// event filter that every OTel and usage record and every standard-level
// hook record pass (daemon.applyEventLevel).
func checkNormalizedMember(t *testing.T, probe levelProbe, level privacy.ContentLevel, treatment string) {
	assertTreatment(t, probe.Normalized, privacy.ApplyEventContentLevel(probe.Normalized, level), probe.Path, treatment)
}

func assertTreatment(t *testing.T, input, sent map[string]any, path, treatment string) {
	t.Helper()
	written, found := valueAt(input, path)
	if !found {
		t.Fatalf("probe path %s is not in its input", path)
	}
	encoded, _ := json.Marshal(sent)
	topMember := strings.SplitN(path, ".", 2)[0]
	_, memberPresent := sent[topMember]
	text, isText := written.(string)
	// Compared as it appears in JSON, so a newline in a diff still matches.
	quoted, _ := json.Marshal(text)
	sentinel := bytes.Trim(quoted, `"`)
	switch treatment {
	case "sent":
		if got, _ := valueAt(sent, path); !reflect.DeepEqual(got, written) {
			t.Fatalf("%s must be sent as written: got %v in %s", path, got, encoded)
		}
	case "withheld":
		if !isText || bytes.Contains(encoded, sentinel) {
			t.Fatalf("%s must be withheld: %s", path, encoded)
		}
		if !memberPresent {
			t.Fatalf("a withheld %s still sends its size and fingerprint: %s", topMember, encoded)
		}
	case "removed":
		if memberPresent || isText && bytes.Contains(encoded, sentinel) {
			t.Fatalf("%s must be removed: %s", path, encoded)
		}
	default:
		t.Fatalf("treatment %q does not apply to a member", treatment)
	}
}

func checkWorkingDirectory(t *testing.T, probe levelProbe, level privacy.ContentLevel, treatment string) {
	want := map[string]string{"name_only": probe.NameOnly, "project_relative": probe.ProjectRelative}[treatment]
	if want == "" {
		t.Fatalf("treatment %q does not apply to the working folder", treatment)
	}
	event := map[string]any{
		"session": map[string]any{"id": "s1", "working_directory": probe.WorkingDirectory},
		"raw":     map[string]any{"cwd": probe.WorkingDirectory},
	}
	sent := uploadedEvent(event, level, privacy.Place{Roots: []string{probe.Root}, Homes: []string{"/home/dev"}})
	session, _ := sent["session"].(map[string]any)
	raw, _ := sent["raw"].(map[string]any)
	if session["working_directory"] != want || raw["cwd"] != want {
		t.Fatalf("working folder at %s: want %q, got session %v raw %v", level, want, session["working_directory"], raw["cwd"])
	}
}

// uploadedEvent is what daemon.enqueue does to a normalized event.
func uploadedEvent(event map[string]any, level privacy.ContentLevel, place privacy.Place) map[string]any {
	return privacy.PlaceEvent(privacy.WorkingDirectoryName(event, level), place)
}

func valueAt(value any, path string) (any, bool) {
	for _, segment := range strings.Split(path, ".") {
		switch typed := value.(type) {
		case map[string]any:
			child, ok := typed[segment]
			if !ok {
				return nil, false
			}
			value = child
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(typed) {
				return nil, false
			}
			value = typed[index]
		default:
			return nil, false
		}
	}
	return value, true
}
