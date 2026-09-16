// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package telemetry

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"go.opentelemetry.io/otel"
	collector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
)

type recordingTraceCollector struct {
	collector.UnimplementedTraceServiceServer
	requests chan *collector.ExportTraceServiceRequest
}

func (c *recordingTraceCollector) Export(_ context.Context, request *collector.ExportTraceServiceRequest) (*collector.ExportTraceServiceResponse, error) {
	c.requests <- request
	return &collector.ExportTraceServiceResponse{}, nil
}

func TestInit_OTLPExportsSpanOnShutdown(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	receiver := &recordingTraceCollector{requests: make(chan *collector.ExportTraceServiceRequest, 1)}
	collector.RegisterTraceServiceServer(server, receiver)
	go server.Serve(listener)
	t.Cleanup(server.Stop)

	previousProvider, previousTracer := otel.GetTracerProvider(), Tracer
	t.Cleanup(func() {
		otel.SetTracerProvider(previousProvider)
		Tracer = previousTracer
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdown, err := Init(ctx, config.TelemetryConfig{
		Enabled: true, Exporter: "otlp", Endpoint: listener.Addr().String(),
		ServiceName: "runner-export-test", SampleRate: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, span := Tracer.Start(ctx, "qualified-export")
	span.End()
	if err := shutdown(ctx); err != nil {
		t.Fatalf("flush/shutdown: %v", err)
	}
	select {
	case request := <-receiver.requests:
		if len(request.ResourceSpans) != 1 || len(request.ResourceSpans[0].ScopeSpans) != 1 {
			t.Fatalf("unexpected resource/scope groups: %v", request)
		}
		spans := request.ResourceSpans[0].ScopeSpans[0].Spans
		if len(spans) != 1 || spans[0].Name != "qualified-export" {
			t.Fatalf("unexpected exported spans: %v", spans)
		}
	case <-ctx.Done():
		t.Fatal("shutdown returned without delivering the span to the local OTLP collector")
	}
}
