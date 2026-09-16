// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package telemetry

import (
	"context"
	"fmt"
	"log/slog"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

var noop = trace.NewNoopTracerProvider().Tracer("noop")

// Tracer is the package-level tracer for the runner agent.
// Defaults to noop so callers never hit nil even without Init().
var Tracer trace.Tracer = noop

// Init initializes the OTel trace provider based on config.
// Returns a shutdown function that should be called on process exit.
// When telemetry is disabled, Init sets up a noop tracer and returns a noop shutdown.
func Init(ctx context.Context, cfg config.TelemetryConfig) (func(context.Context) error, error) {
	if !cfg.Enabled {
		Tracer = noop
		slog.Info("telemetry disabled")
		return func(context.Context) error { return nil }, nil
	}

	var exporter sdktrace.SpanExporter
	var err error

	switch cfg.Exporter {
	case "stdout":
		exporter, err = stdouttrace.New(stdouttrace.WithPrettyPrint())
	case "otlp":
		exporter, err = otlptracegrpc.New(ctx,
			otlptracegrpc.WithEndpoint(cfg.Endpoint),
			otlptracegrpc.WithInsecure(),
		)
	default:
		Tracer = noop
		return func(context.Context) error { return nil }, nil
	}
	if err != nil {
		return nil, fmt.Errorf("creating exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			attribute.String("gen_ai.system", "backplane-runner"),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("creating resource: %w", err)
	}

	sampler := sdktrace.AlwaysSample()
	if cfg.SampleRate < 1.0 {
		sampler = sdktrace.TraceIDRatioBased(cfg.SampleRate)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)
	otel.SetTracerProvider(tp)
	Tracer = tp.Tracer("backplane-runner")

	slog.Info("telemetry initialized", "exporter", cfg.Exporter, "endpoint", cfg.Endpoint)
	return tp.Shutdown, nil
}
