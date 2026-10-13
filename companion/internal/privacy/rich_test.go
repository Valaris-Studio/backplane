// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy_test

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

func TestRichIsAKnownLevelAndItsEventsAreFull(t *testing.T) {
	level, err := privacy.ParseContentLevel("rich")
	if err != nil || level != privacy.Rich {
		t.Fatalf("ParseContentLevel(rich) = %q, %v", level, err)
	}
	for _, level := range []privacy.ContentLevel{privacy.Metadata, privacy.Standard, privacy.Full} {
		if privacy.EventLevel(level) != level {
			t.Errorf("EventLevel(%s) = %s", level, privacy.EventLevel(level))
		}
	}
	if privacy.EventLevel(privacy.Rich) != privacy.Full {
		t.Fatalf("EventLevel(rich) = %s, want full", privacy.EventLevel(privacy.Rich))
	}
}

// Every probe of the levels table is reduced at rich exactly as at full: the
// hook payload path (shim and daemon) and the normalized event filter. The
// table itself keeps its three levels until the desktop's PRIVACY_LEVELS
// gains rich (RC-06): both read the same file.
func TestRichReducesEveryProbeExactlyLikeFull(t *testing.T) {
	table := readLevelsTable(t)
	for _, category := range table.Categories {
		for index, probe := range category.Probes {
			t.Run(category.ID+"/"+strconv.Itoa(index), func(t *testing.T) {
				switch probe.Kind {
				case "working_directory":
					event := map[string]any{"session": map[string]any{"working_directory": probe.WorkingDirectory}}
					place := privacy.Place{Roots: []string{probe.Root}}
					same(t, uploadedEvent(event, privacy.Rich, place), uploadedEvent(event, privacy.Full, place))
				case "normalized":
					same(t, privacy.ApplyEventContentLevel(probe.Normalized, privacy.Rich), privacy.ApplyEventContentLevel(probe.Normalized, privacy.Full))
				default:
					adapter := adapters[probe.Agent]
					same(t, deviceReduce(adapter, probe.Event, probe.Payload, privacy.Rich), deviceReduce(adapter, probe.Event, probe.Payload, privacy.Full))
				}
			})
		}
	}
}

// Rich keeps full's 16 KiB tool-output bound inside events: the uncut body
// travels as content, never in the event.
func TestRichToolOutputInsideEventsIsBoundedLikeFull(t *testing.T) {
	long := make([]byte, 64<<10)
	for index := range long {
		long[index] = 'x'
	}
	payload := map[string]any{"tool_response": string(long)}
	rich, _ := privacy.SanitizeFor(payload, []string{"tool_response"}, privacy.Rich)
	full, _ := privacy.SanitizeFor(payload, []string{"tool_response"}, privacy.Full)
	same(t, rich, full)
	if text := rich["tool_response"].(string); len(text) >= len(long) || len(text) < privacy.MaxFullToolOutputBytes {
		t.Fatalf("rich tool output kept %d bytes", len(text))
	}
}

func same(t *testing.T, got, want map[string]any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		encodedGot, _ := json.Marshal(got)
		encodedWant, _ := json.Marshal(want)
		t.Fatalf("rich reduced to\n%s\nfull to\n%s", encodedGot, encodedWant)
	}
}

// R2-5/R3-3: the device produces each shared vector's device_placed, the
// three known gaps included (a Windows root spelled with forward slashes, a
// macOS root in another case, a JSON-escaped root inside text).
func TestDevicePlacesEveryContractPlacementVector(t *testing.T) {
	for _, vector := range contracttest.PlacementVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			place := privacy.Place{Roots: vector.Roots, Homes: vector.Homes}
			var got string
			switch vector.Mode {
			case "text":
				got = privacy.PlaceText(vector.Raw, place)
			case "value":
				got = privacy.PlaceValue(vector.Raw, place)
			default:
				t.Fatalf("unknown mode %q", vector.Mode)
			}
			if got != vector.DevicePlaced {
				t.Fatalf("placed %q\n got %q\nwant %q (gap fixed in %v)", vector.Raw, got, vector.DevicePlaced, vector.ExpectedFixIn)
			}
			// Placement is idempotent: the server's backstop check is
			// place_text(placed) == placed.
			if again := privacy.PlaceText(got, privacy.Place{Roots: vector.Roots}); again != got {
				t.Fatalf("placing %q again changed it to %q", got, again)
			}
		})
	}
}

// The device's own home is placed in the same spellings as a root: another
// case on a case-insensitive volume, forward slashes on Windows and the
// JSON-escaped form.
func TestDeviceHomeIsPlacedInEverySpellingOfItsRoot(t *testing.T) {
	cases := []struct {
		name, home, raw, want string
	}{
		{"macOS case", "/" + "Users/me", "see /" + "users/me/notes.txt", "see ~/notes.txt"},
		{"Windows slashes", `C:\` + `Users\me`, "see C:/" + "Users/me/notes.txt", "see ~/notes.txt"},
		{"JSON escaped", "/home/me", `{"p":"\/home\/me\/notes.txt"}`, `{"p":"~\/notes.txt"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := privacy.PlaceText(c.raw, privacy.Place{Homes: []string{c.home}}); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}

// From 64 KiB a text is first searched for each pattern's literal; that
// must never change what is placed or redacted, (?i)'s Unicode folds
// included.
func TestLargeTextsArePlacedAndRedactedLikeSmallOnes(t *testing.T) {
	place := privacy.Place{Roots: []string{"/home/me/code/app"}, Homes: []string{"/home/me"}}
	for _, tail := range []string{
		" see /home/me/code/app/a.go, \\/home\\/me\\/code\\/app\\/b.go and " + "/" + "Users/alice/x/ ",
		" open FILE:///home/me/notes.txt ",
		// Assembled at runtime: the public export's secret scanner reads source.
		" export " + "API_" + "KEY=" + "abcdefgh" + "12345678 and \u017fecret=" + strings.Repeat("z", 12) + " ",
	} {
		small := "head" + tail
		large := strings.Repeat("x", 70<<10) + tail
		if got, want := privacy.PlaceText(large, place)[70<<10:], privacy.PlaceText(small, place)[len("head"):]; got != want {
			t.Errorf("placed %q\n large %q\n small %q", tail, got, want)
		}
		redactedSmall, countSmall := privacy.Redact(small)
		redactedLarge, countLarge := privacy.Redact(large)
		if redactedLarge[70<<10:] != redactedSmall[len("head"):] || countLarge != countSmall {
			t.Errorf("redacted %q: large %q (%d), small %q (%d)", tail, redactedLarge[70<<10:], countLarge, redactedSmall[len("head"):], countSmall)
		}
	}
}
