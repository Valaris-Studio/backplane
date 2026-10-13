// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package otlpgate is the companion's loopback OTLP/HTTP receiver.
//
// Threat model: any local user can POST to the loopback port, but nothing
// they send can create a scope decision (those come only from the owner's
// agent hooks), so foreign telemetry is dropped or expires. It decides
// per record, by agent thread, whether telemetry is in capture scope before
// anything is retained: in-scope records are forwarded to the normalizing
// collector, out-of-scope records are dropped, and records whose thread has
// no decision yet are held in memory only, briefly, then dropped.
package otlpgate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"

	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

// HoldTTL bounds how long telemetry may wait for its thread's scope
// decision. Codex emits conversation_starts before the first SessionStart
// hook runs, so a short hold is required; anything still undecided is dropped.
const HoldTTL = 30 * time.Second

const (
	maxRequestBytes = 16 << 20
	maxHeldItems    = 2048
	maxHeldBytes    = 16 << 20
	maxTraceThreads = 4096
	// maxInFlight bounds concurrent requests; more are refused with 503.
	maxInFlight = 4
)

type Signal string

const (
	Logs   Signal = "logs"
	Traces Signal = "traces"
)

type Verdict int

const (
	Undecided Verdict = iota
	Forward
	Drop
)

type Decision struct {
	Verdict      Verdict
	MappingID    string
	ContentLevel privacy.ContentLevel
	// Place locates the thread's project for its uploaded events.
	Place privacy.Place
}

type Resolver interface {
	Resolve(ctx context.Context, threadID, harness string) Decision
}

// Forwarder delivers OTLP/JSON to the normalizing collector.
type Forwarder interface {
	Forward(ctx context.Context, signal Signal, body []byte) error
}

type Config struct {
	Resolver  Resolver
	Forwarder Forwarder
	// Harness maps a resource's service.name to the agent harness id.
	Harness func(serviceName string) string
	Now     func() time.Time
	// Backpressure reports that normalized events are not being drained, so
	// new telemetry must be refused rather than risk losing unread events.
	Backpressure func() bool
}

type Stats struct {
	Forwarded uint64 `json:"forwarded"`
	Dropped   uint64 `json:"dropped"`
	Expired   uint64 `json:"expired"`
	Evicted   uint64 `json:"evicted"`
	Refused   uint64 `json:"refused"`
	Held      int    `json:"held"`
}

type heldItem struct {
	signal   Signal
	thread   string
	traceID  string
	harness  string
	logs     plog.Logs
	traces   ptrace.Traces
	size     int
	deadline time.Time
	// viaTrace marks a record whose thread was inferred from its trace id;
	// it is stamped with the thread before forwarding so the normalizer can
	// attribute it to a session.
	viaTrace bool
}

type Gate struct {
	config       Config
	mu           sync.Mutex
	held         []heldItem
	heldBytes    int
	traceThreads map[string]string
	traceOrder   []string
	stats        Stats
	maxHeldItems int
	inFlight     chan struct{}
}

func New(config Config) *Gate {
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Gate{config: config, traceThreads: map[string]string{}, maxHeldItems: maxHeldItems, inFlight: make(chan struct{}, maxInFlight)}
}

func (g *Gate) Stats() Stats {
	g.mu.Lock()
	defer g.mu.Unlock()
	stats := g.stats
	stats.Held = len(g.held)
	return stats
}

func (g *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var signal Signal
	switch r.URL.Path {
	case "/v1/logs":
		signal = Logs
	case "/v1/traces":
		signal = Traces
	default:
		// Metrics carry no thread identity and are never accepted.
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	select {
	case g.inFlight <- struct{}{}:
		defer func() { <-g.inFlight }()
	default:
		g.refuse(w)
		return
	}
	if g.config.Backpressure != nil && g.config.Backpressure() {
		g.refuse(w)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	protobuf := strings.HasPrefix(r.Header.Get("Content-Type"), "application/x-protobuf")
	batch, err := g.split(r.Context(), signal, body, protobuf)
	if errors.Is(err, errMalformed) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if err := g.forward(r.Context(), signal, batch.forwarded); err != nil {
		// Codex retries a 503; nothing from this request is held or counted.
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	g.commit(batch)
	writeEmptyResponse(w, signal, protobuf)
}

// refuse answers 503, which OTLP exporters treat as retryable (whether
// Codex retries is qualified in CR-9).
func (g *Gate) refuse(w http.ResponseWriter) {
	g.mu.Lock()
	g.stats.Refused++
	g.mu.Unlock()
	w.WriteHeader(http.StatusServiceUnavailable)
}

func writeEmptyResponse(w http.ResponseWriter, signal Signal, protobuf bool) {
	var body []byte
	switch {
	case signal == Logs && protobuf:
		body, _ = plogotlp.NewExportResponse().MarshalProto()
	case signal == Logs:
		body, _ = plogotlp.NewExportResponse().MarshalJSON()
	case protobuf:
		body, _ = ptraceotlp.NewExportResponse().MarshalProto()
	default:
		body, _ = ptraceotlp.NewExportResponse().MarshalJSON()
	}
	if protobuf {
		w.Header().Set("Content-Type", "application/x-protobuf")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.Write(body)
}

var errMalformed = errors.New("malformed_otlp")

type splitBatch struct {
	forwarded []heldItem
	held      []heldItem
	dropped   int
}

// split decides every record in a request. Resolution is cached per thread
// for the request so one batch costs one decision per thread.
func (g *Gate) split(ctx context.Context, signal Signal, body []byte, protobuf bool) (splitBatch, error) {
	items, err := decode(signal, body, protobuf)
	if err != nil {
		return splitBatch{}, errMalformed
	}
	g.learnTraceThreads(items)
	batch := splitBatch{}
	decided := map[string]Decision{}
	deadline := g.config.Now().Add(HoldTTL)
	for _, item := range items {
		item.harness = g.config.Harness(item.harness)
		item.deadline = deadline
		switch decision := g.decide(ctx, &item, decided); decision.Verdict {
		case Forward:
			stampThread(item)
			scrub(item, decision.ContentLevel)
			batch.forwarded = append(batch.forwarded, item)
		case Drop:
			batch.dropped++
		default:
			// Only level-independent scrubbing (identity, binary) until the
			// thread's content level is known at release.
			scrub(item, "")
			batch.held = append(batch.held, item)
		}
	}
	return batch, nil
}

func (g *Gate) decide(ctx context.Context, item *heldItem, cache map[string]Decision) Decision {
	if item.thread == "" {
		g.mu.Lock()
		item.thread = g.traceThreads[item.traceID]
		g.mu.Unlock()
		item.viaTrace = item.thread != ""
	}
	if item.thread == "" {
		return Decision{Verdict: Undecided}
	}
	key := item.thread + "\x00" + item.harness
	if decision, known := cache[key]; known {
		return decision
	}
	decision := g.config.Resolver.Resolve(ctx, item.thread, item.harness)
	cache[key] = decision
	return decision
}

func (g *Gate) learnTraceThreads(items []heldItem) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, item := range items {
		if item.thread == "" || item.traceID == "" {
			continue
		}
		if _, known := g.traceThreads[item.traceID]; !known {
			g.traceOrder = append(g.traceOrder, item.traceID)
		}
		g.traceThreads[item.traceID] = item.thread
		for len(g.traceOrder) > maxTraceThreads {
			delete(g.traceThreads, g.traceOrder[0])
			g.traceOrder = g.traceOrder[1:]
		}
	}
}

func (g *Gate) commit(batch splitBatch) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.stats.Forwarded += uint64(len(batch.forwarded))
	g.stats.Dropped += uint64(batch.dropped)
	for _, item := range batch.held {
		g.held = append(g.held, item)
		g.heldBytes += item.size
	}
	for len(g.held) > g.maxHeldItems || g.heldBytes > maxHeldBytes {
		g.heldBytes -= g.held[0].size
		g.held = g.held[1:]
		g.stats.Evicted++
	}
}

// Release re-decides held records: newly in-scope ones are forwarded,
// out-of-scope ones dropped, and any past their TTL dropped as expired even
// if a decision has since arrived. The daemon calls it periodically.
func (g *Gate) Release(ctx context.Context) {
	g.mu.Lock()
	held := g.held
	g.held, g.heldBytes = nil, 0
	g.mu.Unlock()
	now := g.config.Now()
	decided := map[string]Decision{}
	var forwarded, kept []heldItem
	var dropped, expired, sent uint64
	for _, item := range held {
		if !now.Before(item.deadline) {
			expired++
			continue
		}
		switch decision := g.decide(ctx, &item, decided); decision.Verdict {
		case Forward:
			stampThread(item)
			scrub(item, decision.ContentLevel)
			forwarded = append(forwarded, item)
		case Drop:
			dropped++
		default:
			kept = append(kept, item)
		}
	}
	for _, signal := range []Signal{Logs, Traces} {
		batch := itemsOf(forwarded, signal)
		if len(batch) == 0 {
			continue
		}
		if err := g.forward(ctx, signal, batch); err != nil {
			// The collector is unavailable; keep what is still within its TTL.
			kept = append(kept, batch...)
			continue
		}
		sent += uint64(len(batch))
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.stats.Dropped += dropped
	g.stats.Expired += expired
	g.stats.Forwarded += sent
	g.held = append(kept, g.held...)
	for _, item := range g.held {
		g.heldBytes += item.size
	}
}

func itemsOf(items []heldItem, signal Signal) []heldItem {
	var selected []heldItem
	for _, item := range items {
		if item.signal == signal {
			selected = append(selected, item)
		}
	}
	return selected
}

func (g *Gate) forward(ctx context.Context, signal Signal, items []heldItem) error {
	var body []byte
	var err error
	switch signal {
	case Logs:
		merged := plog.NewLogs()
		for _, item := range items {
			if item.signal == Logs {
				// Copied, not moved: a failed forward keeps the held item intact.
				resources := item.logs.ResourceLogs()
				for r := 0; r < resources.Len(); r++ {
					resources.At(r).CopyTo(merged.ResourceLogs().AppendEmpty())
				}
			}
		}
		if merged.LogRecordCount() == 0 {
			return nil
		}
		body, err = plogotlp.NewExportRequestFromLogs(merged).MarshalJSON()
	case Traces:
		merged := ptrace.NewTraces()
		for _, item := range items {
			if item.signal == Traces {
				resources := item.traces.ResourceSpans()
				for r := 0; r < resources.Len(); r++ {
					resources.At(r).CopyTo(merged.ResourceSpans().AppendEmpty())
				}
			}
		}
		if merged.SpanCount() == 0 {
			return nil
		}
		body, err = ptraceotlp.NewExportRequestFromTraces(merged).MarshalJSON()
	}
	if err != nil {
		return err
	}
	return g.config.Forwarder.Forward(ctx, signal, body)
}

// decode splits a request into one item per log record or span, each
// carrying a copy of its resource and scope.
func decode(signal Signal, body []byte, protobuf bool) ([]heldItem, error) {
	if signal == Logs {
		request := plogotlp.NewExportRequest()
		if err := unmarshal(request.UnmarshalProto, request.UnmarshalJSON, body, protobuf); err != nil {
			return nil, err
		}
		return splitLogs(request.Logs()), nil
	}
	request := ptraceotlp.NewExportRequest()
	if err := unmarshal(request.UnmarshalProto, request.UnmarshalJSON, body, protobuf); err != nil {
		return nil, err
	}
	return splitTraces(request.Traces()), nil
}

func unmarshal(proto, json func([]byte) error, body []byte, protobuf bool) error {
	if protobuf {
		return proto(body)
	}
	return json(body)
}

func splitLogs(logs plog.Logs) []heldItem {
	var items []heldItem
	resources := logs.ResourceLogs()
	for r := 0; r < resources.Len(); r++ {
		resource := resources.At(r)
		service := stringAttr(resource.Resource().Attributes(), "service.name")
		scopes := resource.ScopeLogs()
		for s := 0; s < scopes.Len(); s++ {
			records := scopes.At(s).LogRecords()
			for l := 0; l < records.Len(); l++ {
				record := records.At(l)
				single := plog.NewLogs()
				target := single.ResourceLogs().AppendEmpty()
				resource.Resource().CopyTo(target.Resource())
				targetScope := target.ScopeLogs().AppendEmpty()
				scopes.At(s).Scope().CopyTo(targetScope.Scope())
				record.CopyTo(targetScope.LogRecords().AppendEmpty())
				items = append(items, heldItem{
					signal:  Logs,
					logs:    single,
					harness: service,
					thread:  threadOf(record.Attributes()),
					traceID: traceKey(record.TraceID()),
					size:    approximateSize(record.Attributes()) + len(record.Body().AsString()),
				})
			}
		}
	}
	return items
}

func splitTraces(traces ptrace.Traces) []heldItem {
	var items []heldItem
	resources := traces.ResourceSpans()
	for r := 0; r < resources.Len(); r++ {
		resource := resources.At(r)
		service := stringAttr(resource.Resource().Attributes(), "service.name")
		scopes := resource.ScopeSpans()
		for s := 0; s < scopes.Len(); s++ {
			spans := scopes.At(s).Spans()
			for i := 0; i < spans.Len(); i++ {
				span := spans.At(i)
				single := ptrace.NewTraces()
				target := single.ResourceSpans().AppendEmpty()
				resource.Resource().CopyTo(target.Resource())
				targetScope := target.ScopeSpans().AppendEmpty()
				scopes.At(s).Scope().CopyTo(targetScope.Scope())
				span.CopyTo(targetScope.Spans().AppendEmpty())
				thread := threadOf(span.Attributes())
				size := approximateSize(span.Attributes())
				for e := 0; e < span.Events().Len(); e++ {
					attributes := span.Events().At(e).Attributes()
					if thread == "" {
						thread = threadOf(attributes)
					}
					size += approximateSize(attributes)
				}
				items = append(items, heldItem{signal: Traces, traces: single, harness: service, thread: thread, traceID: traceKey(span.TraceID()), size: size})
			}
		}
	}
	return items
}

// threadOf reads the agent thread a record belongs to: log events carry
// conversation.id, Codex's turn span carries thread.id.
func threadOf(attributes pcommon.Map) string {
	for _, key := range []string{"conversation.id", "thread.id", "thread_id"} {
		if value := stringAttr(attributes, key); value != "" {
			return value
		}
	}
	return ""
}

func traceKey(id pcommon.TraceID) string {
	if id.IsEmpty() {
		return ""
	}
	return id.String()
}

func stringAttr(attributes pcommon.Map, key string) string {
	if value, ok := attributes.Get(key); ok {
		return value.AsString()
	}
	return ""
}

func approximateSize(attributes pcommon.Map) int {
	size := 0
	attributes.Range(func(key string, value pcommon.Value) bool {
		size += len(key) + len(value.AsString())
		return true
	})
	return size
}
