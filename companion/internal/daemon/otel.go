// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/otlpgate"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

const (
	// resolveCacheTTL bounds how long a thread decision is reused, so a
	// policy change or pause applies to that thread's telemetry within
	// seconds.
	resolveCacheTTL    = 2 * time.Second
	gateRetryInterval  = 30 * time.Second
	releaseInterval    = time.Second
	otelHealthInterval = 10 * time.Second
)

type OTelConfig struct {
	// GatePort is the loopback port Codex's exporters were configured with.
	GatePort int
	// Collector is the verified beacon-otelcol executable.
	Collector string
	// Harness maps an OTLP service.name to the agent harness id.
	Harness func(serviceName string) string
}

type resolvedThread struct {
	decision otlpgate.Decision
	until    time.Time
}

// Resolve decides whether a thread's telemetry is in scope, from the working
// directory its hooks recorded and the freshest policy. A thread with no
// hook decision yet, or a transient admission state, is Undecided.
func (d *Daemon) Resolve(ctx context.Context, threadID, harness string) otlpgate.Decision {
	d.resolveMu.Lock()
	defer d.resolveMu.Unlock()
	key := threadID + "\x00" + harness
	now := d.config.Now()
	if cached, ok := d.resolved[key]; ok && now.Before(cached.until) {
		return cached.decision
	}
	threads, err := state.Load[state.Threads](d.config.Layout.Threads())
	thread, known := threads.Threads[threadID]
	if err != nil || !known {
		return otlpgate.Decision{Verdict: otlpgate.Undecided}
	}
	decision, err := d.decide(ctx, harness, thread.Cwd)
	result := otlpgate.Decision{Verdict: otlpgate.Undecided}
	switch {
	case err != nil:
		return result
	case decision.InScope:
		result = otlpgate.Decision{Verdict: otlpgate.Forward, MappingID: decision.MappingID, ContentLevel: decision.ContentLevel, Place: decision.Place}
	case !decision.Reason.Transient():
		result = otlpgate.Decision{Verdict: otlpgate.Drop}
	}
	if d.resolved == nil {
		d.resolved = map[string]resolvedThread{}
	}
	d.resolved[key] = resolvedThread{decision: result, until: now.Add(resolveCacheTTL)}
	return result
}

// drainOTel is the second daemon source: the collector's normalized events.
// Each line is re-scoped, stripped of device identity and queued under a
// capture id derived from its file position, so a replay is recognized.
func (d *Daemon) drainOTel(ctx context.Context) error {
	dir := d.config.Layout.OTelDir()
	tailer := collector.NewTailer(collector.RuntimePath(dir), filepath.Join(dir, "tail.json"))
	err := tailer.Next(func(line []byte, position collector.Position) error {
		return d.processOTelEvent(ctx, line, position)
	})
	if errors.Is(err, errStopDrain) {
		return nil
	}
	return err
}

func (d *Daemon) processOTelEvent(ctx context.Context, line []byte, position collector.Position) error {
	var event struct {
		SchemaVersion string    `json:"schema_version"`
		Timestamp     time.Time `json:"timestamp"`
		Session       struct {
			ID string `json:"id"`
		} `json:"session"`
		Harness struct {
			Name string `json:"name"`
		} `json:"harness"`
	}
	if json.Unmarshal(line, &event) != nil || event.Session.ID == "" {
		return nil
	}
	adapter, err := d.config.Registry.Lookup(event.Harness.Name)
	if err != nil {
		return nil
	}
	threads, err := state.Load[state.Threads](d.config.Layout.Threads())
	if err != nil {
		return errStopDrain
	}
	thread, known := threads.Threads[event.Session.ID]
	if !known {
		// The gate forwards only decided threads, so this one was evicted
		// from the table since; its scope can no longer be established.
		return nil
	}
	decision := d.Resolve(ctx, event.Session.ID, event.Harness.Name)
	switch decision.Verdict {
	case otlpgate.Drop:
		return nil
	case otlpgate.Undecided:
		// A transient state (stale policy, unauthorized): keep the line.
		return errStopDrain
	}
	d.noteTelemetryHarness(event.Session.ID, event.Harness.Name)
	if _, reads := adapter.(agent.UsageSource); reads && carriesUsage(line) {
		counts, err := d.claimUsage(ctx, adapter, event.Session.ID, usageFromTelemetry)
		if err != nil {
			return err
		}
		if !counts {
			// The session's transcript already counts these responses.
			return nil
		}
	}
	stripped, err := beacon.StripDeviceIdentity(line)
	if err != nil {
		return nil
	}
	// The gate applied the level at forward time; the mapping may have been
	// narrowed since, so apply its current level again.
	if stripped, err = applyEventLevel(stripped, decision.ContentLevel); err != nil {
		return nil
	}
	item := observed{
		captureID:  captureID(event.Harness.Name, position.Key()),
		adapter:    adapter,
		harness:    event.Harness.Name,
		receivedAt: event.Timestamp,
	}
	item.observation.NativeSessionID = event.Session.ID
	item.parentSessionID = d.threadParent(adapter, event.Session.ID, thread)
	if item.receivedAt.IsZero() {
		item.receivedAt = d.config.Now()
	}
	if known, err := d.queue.Has(item.captureID); err != nil || known {
		return err
	}
	return d.enqueue(item, decision.MappingID, decision.Place, decision.ContentLevel, beacon.Result{Events: []json.RawMessage{stripped}, SchemaVersion: event.SchemaVersion})
}

// carriesUsage reports a normalized event with token usage, such as the one
// Beacon makes of Codex's completed-turn span.
func carriesUsage(line []byte) bool {
	if !bytes.Contains(line, []byte(`"usage"`)) {
		return false
	}
	var event struct {
		GenAI struct {
			Usage json.RawMessage `json:"usage"`
		} `json:"gen_ai"`
	}
	return json.Unmarshal(line, &event) == nil && len(event.GenAI.Usage) > 0 && string(event.GenAI.Usage) != "null"
}

func (d *Daemon) updateOTelBackpressure() {
	dir := d.config.Layout.OTelDir()
	backlog, err := collector.NewTailer(collector.RuntimePath(dir), filepath.Join(dir, "tail.json")).Backlog()
	if err == nil {
		d.otelBackpressure.Store(backlog >= collector.BacklogLimit)
	}
}

type collectorForwarder struct{ supervisor *collector.Supervisor }

func (f collectorForwarder) Forward(ctx context.Context, signal otlpgate.Signal, body []byte) error {
	base := f.supervisor.URL()
	if base == "" {
		return fmt.Errorf("collector not running")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1/"+string(signal), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := loopbackClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("collector returned %d", response.StatusCode)
	}
	return nil
}

var loopbackClient = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}

// startOTel runs the collector, the gate and its release loop until ctx ends.
func (d *Daemon) startOTel(ctx context.Context) func() {
	ctx, cancel := context.WithCancel(ctx)
	supervisor := &collector.Supervisor{Executable: d.config.OTel.Collector, Dir: d.config.Layout.OTelDir(), ReportError: d.recordOTelError}
	gate := otlpgate.New(otlpgate.Config{Resolver: d, Forwarder: collectorForwarder{supervisor}, Harness: d.config.OTel.Harness, Now: d.config.Now, Backpressure: d.otelBackpressure.Load})
	var group sync.WaitGroup
	group.Add(3)
	go func() { defer group.Done(); supervisor.Run(ctx) }()
	go func() { defer group.Done(); d.serveGate(ctx, gate) }()
	go func() { defer group.Done(); d.releaseLoop(ctx, gate, supervisor) }()
	return func() {
		cancel()
		group.Wait()
	}
}

// serveGate listens on the loopback gate port, retrying while it is taken.
func (d *Daemon) serveGate(ctx context.Context, gate *otlpgate.Gate) {
	for ctx.Err() == nil {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", d.config.OTel.GatePort))
		if err != nil {
			d.recordOTelError("gate_port_unavailable")
			select {
			case <-ctx.Done():
			case <-time.After(gateRetryInterval):
			}
			continue
		}
		server := &http.Server{Handler: gate, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			<-ctx.Done()
			shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			server.Shutdown(shutdown)
		}()
		server.Serve(listener)
	}
}

func (d *Daemon) releaseLoop(ctx context.Context, gate *otlpgate.Gate, supervisor *collector.Supervisor) {
	ticker := time.NewTicker(releaseInterval)
	defer ticker.Stop()
	lastHealth := time.Time{}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		gate.Release(ctx)
		if time.Since(lastHealth) >= otelHealthInterval {
			lastHealth = time.Now()
			d.recordOTelHealth(gate.Stats(), supervisor.URL() != "")
		}
	}
}

func (d *Daemon) recordOTelHealth(stats otlpgate.Stats, collectorRunning bool) {
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		next := state.OTelHealth{CollectorRunning: collectorRunning, Forwarded: stats.Forwarded, Dropped: stats.Dropped, Expired: stats.Expired, Evicted: stats.Evicted, Held: stats.Held}
		if health.OTel != nil {
			next.LastError = health.OTel.LastError
			if *health.OTel == next {
				return false
			}
		}
		health.OTel = &next
		return true
	})
}

func (d *Daemon) recordOTelError(code string) {
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		if health.OTel == nil {
			health.OTel = &state.OTelHealth{}
		}
		health.OTel.LastError = code
		return true
	})
}

func applyEventLevel(line json.RawMessage, level privacy.ContentLevel) (json.RawMessage, error) {
	level = privacy.EventLevel(level)
	var event map[string]any
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	if err := decoder.Decode(&event); err != nil {
		return nil, err
	}
	normalizeCodexResult(event)
	// Named before digesting, so a working directory's fingerprint is its
	// folder name's and not the local path's.
	return encodeEvent(privacy.ApplyEventContentLevel(privacy.WorkingDirectoryName(event, level), level))
}
