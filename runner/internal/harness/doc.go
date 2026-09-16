// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package harness defines the interfaces for agent harness engineering.
//
// An agent harness consists of two types of components:
//
//   - Guides (feedforward): shape agent behavior BEFORE it acts.
//     Examples: prompt templates, tool restrictions, context injection.
//
//   - Sensors (feedback): observe agent output AFTER it acts.
//     Examples: linters (computational), LLM review (inferential).
//
// This package defines the contracts only. Implementations live in
// the packages that own the behavior (e.g., workloop strategies,
// future linter/test integrations).
//
// Reference: Martin Fowler, "Harness Engineering" (April 2026).
// https://martinfowler.com/articles/harness-engineering.html
package harness
