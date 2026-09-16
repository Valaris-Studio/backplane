// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

func TestInit_Disabled(t *testing.T) {
	cfg := config.TelemetryConfig{Enabled: false}
	shutdown, err := Init(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Init returned error: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown returned error: %v", err)
	}
	// Tracer should be noop — creating a span should not panic.
	_, span := Tracer.Start(context.Background(), "test")
	span.End()
}

func TestInit_Stdout(t *testing.T) {
	cfg := config.TelemetryConfig{
		Enabled:     true,
		Exporter:    "stdout",
		ServiceName: "test-service",
		SampleRate:  1.0,
	}
	shutdown, err := Init(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Init returned error: %v", err)
	}
	defer shutdown(context.Background())

	// Tracer should be functional.
	_, span := Tracer.Start(context.Background(), "test-span")
	span.End()
}

func TestInit_UnknownExporter(t *testing.T) {
	cfg := config.TelemetryConfig{
		Enabled:  true,
		Exporter: "unknown",
	}
	shutdown, err := Init(context.Background(), cfg)
	if err != nil {
		t.Fatalf("Init returned error: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown returned error: %v", err)
	}
	// Should fall back to noop.
	_, span := Tracer.Start(context.Background(), "test")
	span.End()
}

func TestStartTickSpan(t *testing.T) {
	// Set up in-memory exporter to capture spans.
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	Tracer = tp.Tracer("test")
	defer tp.Shutdown(context.Background())

	ctx, span := StartTickSpan(context.Background(), "orchestrator")
	span.End()
	_ = ctx

	tp.ForceFlush(context.Background())

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if spans[0].Name != "invoke_agent" {
		t.Errorf("span name = %q, want %q", spans[0].Name, "invoke_agent")
	}

	foundRole := false
	for _, attr := range spans[0].Attributes {
		if attr.Key == "gen_ai.agent.role" && attr.Value.AsString() == "orchestrator" {
			foundRole = true
		}
	}
	if !foundRole {
		t.Error("span missing gen_ai.agent.role=orchestrator attribute")
	}
}

func TestRecordLLMResult(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	Tracer = tp.Tracer("test")
	defer tp.Shutdown(context.Background())

	_, span := StartLLMSpan(context.Background(), "sonnet")
	RecordLLMResult(span, 1000, 500, 200, 300, 0.05)
	span.End()

	tp.ForceFlush(context.Background())

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}

	expected := map[attribute.Key]any{
		"gen_ai.request.model":                     "sonnet",
		"gen_ai.usage.input_tokens":                int64(1000),
		"gen_ai.usage.output_tokens":               int64(500),
		"gen_ai.usage.cache_creation.input_tokens":  int64(200),
		"gen_ai.usage.cache_read.input_tokens":      int64(300),
		"gen_ai.usage.cost_usd":                    0.05,
	}

	attrs := make(map[attribute.Key]attribute.Value)
	for _, a := range spans[0].Attributes {
		attrs[a.Key] = a.Value
	}

	for key, want := range expected {
		got, ok := attrs[key]
		if !ok {
			t.Errorf("missing attribute %q", key)
			continue
		}
		switch v := want.(type) {
		case string:
			if got.AsString() != v {
				t.Errorf("attribute %q = %q, want %q", key, got.AsString(), v)
			}
		case int64:
			if got.AsInt64() != v {
				t.Errorf("attribute %q = %d, want %d", key, got.AsInt64(), v)
			}
		case float64:
			if got.AsFloat64() != v {
				t.Errorf("attribute %q = %f, want %f", key, got.AsFloat64(), v)
			}
		}
	}
}

func TestStartPhaseSpan(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	Tracer = tp.Tracer("test")
	defer tp.Shutdown(context.Background())

	_, span := StartPhaseSpan(context.Background(), "discover",
		attribute.String("valaris.card_id", "card-123"),
	)
	span.End()

	tp.ForceFlush(context.Background())

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}
	if spans[0].Name != "gen_ai.discover" {
		t.Errorf("span name = %q, want %q", spans[0].Name, "gen_ai.discover")
	}

	foundPhase := false
	foundCard := false
	for _, attr := range spans[0].Attributes {
		if attr.Key == "gen_ai.phase" && attr.Value.AsString() == "discover" {
			foundPhase = true
		}
		if attr.Key == "valaris.card_id" && attr.Value.AsString() == "card-123" {
			foundCard = true
		}
	}
	if !foundPhase {
		t.Error("span missing gen_ai.phase=discover attribute")
	}
	if !foundCard {
		t.Error("span missing valaris.card_id=card-123 attribute")
	}
}

func TestRecordCardID(t *testing.T) {
	exporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	Tracer = tp.Tracer("test")
	defer tp.Shutdown(context.Background())

	_, span := Tracer.Start(context.Background(), "test-span")
	RecordCardID(span, "card-456")
	span.End()

	tp.ForceFlush(context.Background())

	spans := exporter.GetSpans()
	if len(spans) != 1 {
		t.Fatalf("expected 1 span, got %d", len(spans))
	}

	found := false
	for _, attr := range spans[0].Attributes {
		if attr.Key == "valaris.card_id" && attr.Value.AsString() == "card-456" {
			found = true
		}
	}
	if !found {
		t.Error("span missing valaris.card_id=card-456 attribute")
	}
}
