// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package telemetry

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// StartTickSpan creates the root span for a work loop tick.
func StartTickSpan(ctx context.Context, role string) (context.Context, trace.Span) {
	return Tracer.Start(ctx, "invoke_agent",
		trace.WithAttributes(
			attribute.String("gen_ai.agent.role", role),
		),
	)
}

// StartPhaseSpan creates a child span for a pipeline phase (discover, claim, implement, ship, review, document).
func StartPhaseSpan(ctx context.Context, phase string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	allAttrs := append([]attribute.KeyValue{
		attribute.String("gen_ai.phase", phase),
	}, attrs...)
	return Tracer.Start(ctx, "gen_ai."+phase, trace.WithAttributes(allAttrs...))
}

// StartLLMSpan creates a child span for an LLM invocation.
func StartLLMSpan(ctx context.Context, model string) (context.Context, trace.Span) {
	return Tracer.Start(ctx, "gen_ai.chat",
		trace.WithAttributes(
			attribute.String("gen_ai.request.model", model),
		),
	)
}

// RecordLLMResult adds token usage and cost attributes to an LLM span.
func RecordLLMResult(span trace.Span, inputTokens, outputTokens, cacheCreation, cacheRead int, costUSD float64) {
	span.SetAttributes(
		attribute.Int("gen_ai.usage.input_tokens", inputTokens),
		attribute.Int("gen_ai.usage.output_tokens", outputTokens),
		attribute.Int("gen_ai.usage.cache_creation.input_tokens", cacheCreation),
		attribute.Int("gen_ai.usage.cache_read.input_tokens", cacheRead),
		attribute.Float64("gen_ai.usage.cost_usd", costUSD),
	)
}

// RecordCardID sets the card ID attribute on a span.
func RecordCardID(span trace.Span, cardID string) {
	span.SetAttributes(attribute.String("valaris.card_id", cardID))
}
