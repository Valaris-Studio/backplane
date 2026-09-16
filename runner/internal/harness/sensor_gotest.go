// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type GoTestSensor struct {
	packages string
	timeout  string
	tags     string
}

// Defaults applied when NewGoTestSensor is given an empty or nil config.
// GoTestManifest publishes these verbatim so the platform can render
// placeholder values in the pipeline builder.
const (
	goTestDefaultPackages = "./..."
	goTestDefaultTimeout  = "120s"
	goTestDefaultTags     = ""
)

// GoTestManifest returns the sensor manifest entry for go-test. The registry
// pairs this with NewGoTestSensor so Catalog() can expose the sensor to the
// platform.
func GoTestManifest() SensorManifestEntry {
	return SensorManifestEntry{
		Name: "go-test",
		Kind: SensorKindComputational,
		DefaultConfig: map[string]any{
			"packages": goTestDefaultPackages,
			"timeout":  goTestDefaultTimeout,
			"tags":     goTestDefaultTags,
		},
		ConfigSchema: map[string]any{
			"packages": "string",
			"timeout":  "string",
			"tags":     "string",
		},
		Description: "Runs Go tests via `go test -json` and fails on any test failure.",
	}
}

// NewGoTestSensor is the SensorConstructor for the go-test sensor.
func NewGoTestSensor(config map[string]any) (Sensor, error) {
	s := &GoTestSensor{
		packages: goTestDefaultPackages,
		timeout:  goTestDefaultTimeout,
	}
	if config == nil {
		return s, nil
	}
	if v, ok := config["packages"].(string); ok && v != "" {
		s.packages = v
	}
	if v, ok := config["timeout"].(string); ok && v != "" {
		s.timeout = v
	}
	if v, ok := config["tags"].(string); ok && v != "" {
		s.tags = v
	}
	return s, nil
}

func (s *GoTestSensor) Name() string        { return "go-test" }
func (s *GoTestSensor) Kind() SensorKind    { return Computational }
func (s *GoTestSensor) Packages() string     { return s.packages }
func (s *GoTestSensor) Timeout() string      { return s.timeout }
func (s *GoTestSensor) Tags() string         { return s.tags }

// go test -json emits one JSON object per line with these fields.
type goTestEvent struct {
	Action  string  `json:"Action"`
	Package string  `json:"Package"`
	Test    string  `json:"Test"`
	Output  string  `json:"Output"`
	Elapsed float64 `json:"Elapsed"`
}

func (s *GoTestSensor) Evaluate(ctx context.Context, input SensorInput) (*SensorResult, error) {
	start := time.Now()

	args := []string{"test", "-json", "-timeout", s.timeout}
	if s.tags != "" {
		args = append(args, "-tags", s.tags)
	}
	args = append(args, s.packages)

	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Dir = input.WorkingDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	durationMS := time.Since(start).Milliseconds()

	// Parse JSON lines even on non-zero exit (tests may have failed).
	type testOutcome struct {
		passed bool
		output []string
	}
	tests := make(map[string]*testOutcome) // key: "Package::TestName"
	packageResults := make(map[string]bool)

	scanner := bufio.NewScanner(&stdout)
	for scanner.Scan() {
		var ev goTestEvent
		if err := json.Unmarshal(scanner.Bytes(), &ev); err != nil {
			continue
		}

		switch ev.Action {
		case "pass":
			if ev.Test != "" {
				key := ev.Package + "::" + ev.Test
				if tests[key] == nil {
					tests[key] = &testOutcome{}
				}
				tests[key].passed = true
			} else {
				packageResults[ev.Package] = true
			}
		case "fail":
			if ev.Test != "" {
				key := ev.Package + "::" + ev.Test
				if tests[key] == nil {
					tests[key] = &testOutcome{}
				}
				tests[key].passed = false
			} else {
				packageResults[ev.Package] = false
			}
		case "output":
			if ev.Test != "" {
				key := ev.Package + "::" + ev.Test
				if tests[key] == nil {
					tests[key] = &testOutcome{}
				}
				tests[key].output = append(tests[key].output, ev.Output)
			}
		}
	}

	// If we got no JSON output at all, treat as a command-level failure.
	if len(tests) == 0 && len(packageResults) == 0 {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" && runErr != nil {
			errMsg = runErr.Error()
		}
		if errMsg == "" {
			errMsg = "go test produced no output"
		}
		return &SensorResult{
			Passed:     false,
			Summary:    "go test failed to run",
			DurationMS: durationMS,
			Findings: []Finding{{
				Severity: "error",
				Message:  errMsg,
				Rule:     "go-test/execution",
			}},
		}, nil
	}

	var findings []Finding
	passed, failed := 0, 0
	for key, outcome := range tests {
		if outcome.passed {
			passed++
		} else {
			failed++
			parts := strings.SplitN(key, "::", 2)
			findings = append(findings, Finding{
				Severity: "error",
				File:     parts[0],
				Message:  strings.Join(outcome.output, ""),
				Rule:     "go-test/fail",
			})
		}
	}

	total := passed + failed
	allPassed := failed == 0 && runErr == nil

	var summary string
	if allPassed {
		summary = fmt.Sprintf("%d/%d tests passed", passed, total)
	} else {
		summary = fmt.Sprintf("%d tests failed", failed)
	}

	score := 0.0
	if total > 0 {
		score = float64(passed) / float64(total)
	}

	return &SensorResult{
		Passed:     allPassed,
		Score:      score,
		Findings:   findings,
		Summary:    summary,
		DurationMS: durationMS,
	}, nil
}
