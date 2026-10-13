// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

func TestPolicyRequestAnnouncesRichCapture(t *testing.T) {
	server := uplinktest.New(t)
	if _, err := deviceClient(t, server.URL).Policy(context.Background()); err != nil {
		t.Fatal(err)
	}
	if want := contracttest.WireExample(t, "policy-rich-capture-offer.json").HTTP.RequestHeaders[policy.CapabilitiesHeader]; len(server.Capabilities) != 1 || server.Capabilities[0] != want {
		t.Fatalf("capabilities sent: %q, want %q", server.Capabilities, want)
	}
}

func TestPolicyCarriesTheOfferNullOrNothing(t *testing.T) {
	var offer policy.RichCaptureOffer
	if err := json.Unmarshal(contracttest.WireExample(t, "policy-rich-capture-offer.json").Body, &offer); err != nil {
		t.Fatal(err)
	}
	for name, member := range map[string]policy.RichCapture{
		"absent": {},
		"null":   {Present: true},
		"offer":  {Present: true, Offer: &offer},
	} {
		t.Run(name, func(t *testing.T) {
			server := uplinktest.New(t)
			server.Policy.RichCapture = member
			fresh, err := deviceClient(t, server.URL).Policy(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if fresh.RichCapture.Present != member.Present || (fresh.RichCapture.Offer == nil) != (member.Offer == nil) {
				t.Fatalf("decoded %+v from %+v", fresh.RichCapture, member)
			}
		})
	}
}

func serveOnce(t *testing.T, status int, body json.RawMessage) *uplink.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write(body)
	}))
	t.Cleanup(server.Close)
	return deviceClient(t, server.URL)
}

func TestIngestReadsEveryContentAckOfTheWireCorpus(t *testing.T) {
	for _, wire := range contracttest.WireExamples(t) {
		if wire.Model != "RichIngestResult" {
			continue
		}
		t.Run(wire.Name, func(t *testing.T) {
			var want struct {
				Contents []uplink.ContentAck `json:"contents"`
			}
			json.Unmarshal(wire.Body, &want)
			ack, err := serveOnce(t, http.StatusOK, wire.Body).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{}`)})
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(ack.Contents, want.Contents) || len(ack.Contents) != len(want.Contents) {
				t.Fatalf("contents %+v, want %+v", ack.Contents, want.Contents)
			}
		})
	}
}

func TestIngestRefusesContentAcksTheContractForbids(t *testing.T) {
	for _, wire := range contracttest.InvalidWireExamples(t) {
		if wire.Model != "RichIngestResult" {
			continue
		}
		t.Run(wire.Name, func(t *testing.T) {
			_, err := serveOnce(t, http.StatusOK, wire.Body).Ingest(context.Background(), []json.RawMessage{json.RawMessage(`{}`)})
			if !errors.Is(err, uplink.ErrInvalidResponse) {
				t.Fatalf("%s (%s) accepted: %v", wire.Name, wire.Why, err)
			}
		})
	}
}

// What the device sends is what the contract says: every example of a
// device-made model decodes into the Go types, validates, and encodes back
// to the same document.
func TestDeviceModelsRoundTripTheWireCorpus(t *testing.T) {
	for _, wire := range contracttest.WireExamples(t) {
		var value interface{ validate() error }
		switch wire.Model {
		case "RichCaptureRecord":
			value = &recordModel{}
		case "ContentDeclaration":
			value = &declarationModel{}
		case "RichCaptureStatus":
			value = &statusModel{}
		default:
			continue
		}
		t.Run(wire.Name, func(t *testing.T) {
			decoder := json.NewDecoder(bytes.NewReader(wire.Body))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(value); err != nil {
				t.Fatalf("the Go type cannot hold %s: %v", wire.Name, err)
			}
			if err := value.validate(); err != nil {
				t.Fatalf("a valid example fails validation: %v", err)
			}
			encoded, _ := json.Marshal(value)
			if !sameJSON(t, encoded, wire.Body) {
				t.Fatalf("round trip changed the document:\n%s\nwant\n%s", encoded, wire.Body)
			}
		})
	}
}

func TestDeviceValidationRefusesWhatTheServerRefuses(t *testing.T) {
	validated := 0
	defer func() {
		// Examples the Go types cannot hold are refused by decoding; the
		// rest must reach validation, or this test checks nothing.
		if validated < 15 {
			t.Errorf("only %d invalid examples reached validation", validated)
		}
	}()
	for _, wire := range contracttest.InvalidWireExamples(t) {
		var value interface{ validate() error }
		switch wire.Model {
		case "RichCaptureRecord":
			value = &recordModel{}
		case "ContentDeclaration":
			value = &declarationModel{}
		default:
			continue
		}
		t.Run(wire.Name, func(t *testing.T) {
			decoder := json.NewDecoder(bytes.NewReader(wire.Body))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(value); err != nil {
				t.Logf("refused by decoding: %v", err)
				return
			}
			validated++
			if err := value.validate(); err == nil {
				t.Fatalf("%s (%s) passes device validation", wire.Name, wire.Why)
			}
		})
	}
}

type recordModel struct{ uplink.Record }

func (r *recordModel) validate() error { return r.ValidateRich() }

type declarationModel struct{ uplink.ContentDeclaration }

func (d *declarationModel) validate() error { return d.Validate() }

type statusModel struct{ uplink.RichCaptureStatus }

func (*statusModel) validate() error { return nil }

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		t.Fatal("not JSON")
	}
	return reflect.DeepEqual(normalizeTimes(left), normalizeTimes(right))
}

// normalizeTimes compares instants, not their spelling (`Z` vs `.000Z`).
func normalizeTimes(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			typed[key] = normalizeTimes(child)
		}
	case []any:
		for index, child := range typed {
			typed[index] = normalizeTimes(child)
		}
	case string:
		if at, err := time.Parse(time.RFC3339Nano, typed); err == nil {
			return at.UTC().Format(time.RFC3339Nano)
		}
	}
	return value
}

func TestEventsOnlyRewriteKeepsTheEventsUnderADerivedID(t *testing.T) {
	var record uplink.Record
	if err := json.Unmarshal(contracttest.WireExample(t, "ingest-request-rich-record.json").Body, &record); err != nil {
		t.Fatal(err)
	}
	rewritten, ok := record.EventsOnly()
	sum := sha256.Sum256([]byte("events-only\x00" + record.CaptureID))
	if !ok || rewritten.CaptureID != hex.EncodeToString(sum[:])[:32] {
		t.Fatalf("rewritten id %q, ok %v", rewritten.CaptureID, ok)
	}
	if rewritten.Contents != nil || rewritten.CaptureGeneration != nil || !reflect.DeepEqual(rewritten.Events, record.Events) || rewritten.NativeSessionID != record.NativeSessionID {
		t.Fatalf("rewrite kept rich members or lost events: %+v", rewritten)
	}
	encoded, _ := json.Marshal(rewritten)
	if strings.Contains(string(encoded), `"contents"`) || strings.Contains(string(encoded), `"capture_generation"`) {
		t.Fatalf("an older server forbids these members: %s", encoded)
	}
	var contentOnly uplink.Record
	json.Unmarshal(contracttest.WireExample(t, "ingest-request-content-only-record.json").Body, &contentOnly)
	if _, ok := contentOnly.EventsOnly(); ok {
		t.Fatal("a record of contents only has no events-only form")
	}
}

// uploadFixture declares body through the fake's ingest and returns the
// content id its upload_required ack named.
func uploadFixture(t *testing.T, server *uplinktest.Server, client *uplink.Client, body []byte) string {
	t.Helper()
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	size := int64(len(body))
	record := uplink.Record{CaptureID: strings.Repeat("ab", 16), Contents: []uplink.ContentDeclaration{{ContentKey: digest, Delivery: uplink.DeliveryUpload, Coverage: "captured", ByteCount: &size, SHA256: &digest}}}
	encoded, _ := json.Marshal(record)
	ack, err := client.Ingest(context.Background(), []json.RawMessage{encoded})
	if err != nil || len(ack.Contents) != 1 || ack.Contents[0].Outcome != uplink.OutcomeUploadRequired {
		t.Fatalf("declare: %+v %v", ack, err)
	}
	return ack.Contents[0].ContentID
}

func TestChunkedUploadOfALargeTextAndABinaryBody(t *testing.T) {
	swatch := contracttest.SourceDir(t, "codex-cli") + "/swatch.png"
	binary, err := readFile(swatch)
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{"text over 16 KiB": bytes.Repeat([]byte("Zoë→日本語 "), 3000), "binary": binary} {
		t.Run(name, func(t *testing.T) {
			server := uplinktest.New(t)
			server.ChunkBytes = 8 << 10
			client := deviceClient(t, server.URL)
			contentID := uploadFixture(t, server, client, body)
			chunks := (len(body) + 8<<10 - 1) / (8 << 10)
			for index := range chunks {
				chunk := body[index*(8<<10) : min(len(body), (index+1)*(8<<10))]
				receipt, err := client.PutContentChunk(context.Background(), contentID, index, chunk)
				if err != nil || receipt.Index != index || receipt.Complete != (index == chunks-1) {
					t.Fatalf("chunk %d: %+v %v", index, receipt, err)
				}
			}
			sum := sha256.Sum256(body)
			state, err := client.FinalizeContent(context.Background(), contentID, int64(len(body)), hex.EncodeToString(sum[:]))
			if err != nil || state.State != uplink.UploadAvailable {
				t.Fatalf("finalize: %+v %v", state, err)
			}
			if stored := server.Body(hex.EncodeToString(sum[:])); !bytes.Equal(stored, body) {
				t.Fatalf("server holds %d bytes, want %d", len(stored), len(body))
			}
			resumed, err := client.ContentUpload(context.Background(), contentID)
			if err != nil || resumed.State != uplink.UploadAvailable {
				t.Fatalf("status: %+v %v", resumed, err)
			}
		})
	}
}

// The chunk request is the contract's: raw bytes, their length and digest.
func TestChunkRequestCarriesTheContractHeaders(t *testing.T) {
	example := contracttest.WireExample(t, "chunk-upload-request.json")
	chunk, _ := base64.StdEncoding.DecodeString(example.HTTP.BodyBase64)
	var headers struct {
		ContentType   string `json:"content_type"`
		ContentLength int    `json:"content_length"`
		Digest        string `json:"backplane_chunk_sha256"`
	}
	json.Unmarshal(example.Body, &headers)
	var got http.Header
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, gotPath = r.Header.Clone(), r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write(contracttest.WireExample(t, "chunk-receipt-complete.json").Body)
	}))
	defer server.Close()
	contentID := strings.Split(example.HTTP.Path, "/")[4]
	deviceClient(t, server.URL).PutContentChunk(context.Background(), contentID, 0, chunk)
	if gotPath != example.HTTP.Path || got.Get("Content-Type") != headers.ContentType || got.Get("Content-Length") != itoa(headers.ContentLength) || got.Get("Backplane-Chunk-SHA256") != headers.Digest {
		t.Fatalf("PUT %s with %v", gotPath, got)
	}
}

func TestUploadErrorsNameTheirStatusAndCode(t *testing.T) {
	for _, name := range []string{"error-content-not-found.json", "error-upload-expired.json", "error-rich-capture-unavailable.json", "error-upload-incomplete.json", "error-storage-backend-unavailable.json"} {
		t.Run(name, func(t *testing.T) {
			example := contracttest.WireExample(t, name)
			var envelope struct {
				Code string `json:"error_code"`
			}
			json.Unmarshal(example.Body, &envelope)
			_, err := serveOnce(t, example.HTTP.Status, example.Body).FinalizeContent(context.Background(), "2dab8c74-3e5f-4071-8c1d-2e3f4a5b6c7d", 1, strings.Repeat("0", 64))
			var status *uplink.StatusError
			if !errors.As(err, &status) || status.Status != example.HTTP.Status || status.Code != envelope.Code {
				t.Fatalf("error %v, want %d %s", err, example.HTTP.Status, envelope.Code)
			}
		})
	}
}

func TestUploadAnswersTheContractForbidsAreRefused(t *testing.T) {
	for _, wire := range contracttest.InvalidWireExamples(t) {
		switch wire.Model {
		case "ChunkReceipt":
			t.Run(wire.Name, func(t *testing.T) {
				if _, err := serveOnce(t, http.StatusOK, wire.Body).PutContentChunk(context.Background(), "c", 0, []byte("x")); !errors.Is(err, uplink.ErrInvalidResponse) {
					t.Fatalf("%s accepted: %v", wire.Why, err)
				}
			})
		case "ContentUploadState":
			t.Run(wire.Name, func(t *testing.T) {
				if _, err := serveOnce(t, http.StatusOK, wire.Body).ContentUpload(context.Background(), "c"); !errors.Is(err, uplink.ErrInvalidResponse) {
					t.Fatalf("%s accepted: %v", wire.Why, err)
				}
			})
		}
	}
}

// Each request has its own deadline: a chunk may take longer than any JSON
// call, and nothing bounds the client as a whole.
func TestRequestsHaveTheirOwnDeadlines(t *testing.T) {
	restore := uplink.SetDeadlines(100*time.Millisecond, 2*time.Second)
	defer restore()
	server := uplinktest.New(t)
	client := deviceClient(t, server.URL)
	if client.HasGlobalTimeout() {
		t.Fatal("a global timeout cuts chunk uploads to the JSON deadline")
	}
	contentID := uploadFixture(t, server, client, []byte("slow chunk"))
	gate := make(chan struct{})
	server.Lock()
	server.Stall["/api/companion/contents/"+contentID+"/chunks/0"] = gate
	server.Stall["/api/companion/policy"] = gate
	server.Unlock()
	time.AfterFunc(400*time.Millisecond, func() { close(gate) })
	started := time.Now()
	if _, err := client.Policy(context.Background()); !errors.Is(err, uplink.ErrUnavailable) || time.Since(started) > time.Second {
		t.Fatalf("JSON call: %v after %v", err, time.Since(started))
	}
	if _, err := client.PutContentChunk(context.Background(), contentID, 0, []byte("slow chunk")); err != nil {
		t.Fatalf("a chunk within its own deadline failed: %v", err)
	}
}

func TestStatusReportCarriesRichCaptureOnlyWhenSet(t *testing.T) {
	var status uplink.RichCaptureStatus
	json.Unmarshal(contracttest.WireExample(t, "heartbeat-rich-capture-status.json").Body, &status)
	server := uplinktest.New(t)
	client := deviceClient(t, server.URL)
	client.ReportStatus(context.Background(), uplink.StatusReport{CompanionVersion: "1"})
	client.ReportStatus(context.Background(), uplink.StatusReport{CompanionVersion: "1", RichCapture: &status})
	if _, sent := server.Heartbeats[0]["rich_capture"]; sent {
		t.Fatal("an older server forbids rich_capture")
	}
	if _, sent := server.Heartbeats[1]["rich_capture"]; !sent {
		t.Fatal("rich_capture not sent")
	}
}

func readFile(path string) ([]byte, error) { return os.ReadFile(path) }

func itoa(value int) string { return strconv.Itoa(value) }
