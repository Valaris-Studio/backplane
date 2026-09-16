// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Content derived from runner/internal/harness/{sensor.go, registry.go,
// sensor_gotest.go} and the sensor DSL roadmap in the harness docs.

import { SectionPage } from "../shell/SectionPage";
import {
  CodeExample,
  FutureState,
  HonestRemark,
  ImportantNote,
} from "../callouts";

export function ExtendingWritingACustomSensor() {
  return (
    <SectionPage
      title="Writing a Custom Sensor"
      eyebrow="Extending Backplane"
    >
      <p>
        Sensors are the feedback half of the runner harness: they evaluate
        what an agent produced and emit structured pass/fail signals the
        pipeline uses to gate the next step. Today sensors are compiled into
        the Go runner — adding one means writing Go, rebuilding the{" "}
        <code>backplane-runner</code> binary, and shipping a new runner image. This is
        a compile-time extension point, not a runtime one, and it will stay
        that way until the declarative sensor DSL (see below) lands.
      </p>

      <h2 id="the-sensor-interface">The Sensor interface</h2>
      <p>
        A sensor implements three methods: <code>Name()</code>,{" "}
        <code>Kind()</code> (either <code>Computational</code> for
        deterministic checks or <code>Inferential</code> for LLM-backed
        ones), and <code>Evaluate(ctx, input)</code> returning a{" "}
        <code>SensorResult</code> with a pass flag, an optional 0..1 score,
        findings, and a summary. The interface lives in{" "}
        <code>runner/internal/harness/sensor.go</code>.
      </p>

      <CodeExample
        language="go"
        title="The Sensor interface"
      >
        {`// runner/internal/harness/sensor.go
type Sensor interface {
    Name() string                                       // unique id, e.g. "go-test"
    Kind() SensorKind                                   // Computational | Inferential
    Evaluate(ctx context.Context, input SensorInput) (*SensorResult, error)
}

type SensorInput struct {
    FilesChanged []string
    Language     string         // "go", "python", "typescript", …
    WorkingDir   string         // repo root
    CardID       string
    ExecutionID  string
    PRBranch     string
    Extra        map[string]any // sensor-specific context
}

type SensorResult struct {
    Passed     bool
    Score      float64
    Findings   []Finding
    Summary    string
    DurationMS int64
}`}
      </CodeExample>

      <h2 id="a-minimal-sensor">A minimal sensor template</h2>
      <p>
        The shortest useful sensor: a placeholder that checks whether any
        files were changed at all. Not shippable as-is, but demonstrates the
        shape every sensor follows — constructor, manifest, three interface
        methods. Use it as a skeleton when building a real check.
      </p>

      <CodeExample
        language="go"
        title="A minimal custom sensor skeleton"
      >
        {`// runner/internal/harness/sensor_files_changed.go
package harness

import (
    "context"
    "time"
)

type FilesChangedSensor struct {
    minFiles int
}

func FilesChangedManifest() SensorManifestEntry {
    return SensorManifestEntry{
        Name: "files-changed",
        Kind: SensorKindComputational,
        DefaultConfig: map[string]any{"min_files": 1},
        ConfigSchema:  map[string]any{"min_files": "int"},
        Description:   "Fails if fewer than min_files were modified.",
    }
}

func NewFilesChangedSensor(config map[string]any) (Sensor, error) {
    s := &FilesChangedSensor{minFiles: 1}
    if v, ok := config["min_files"].(int); ok && v > 0 {
        s.minFiles = v
    }
    return s, nil
}

func (s *FilesChangedSensor) Name() string     { return "files-changed" }
func (s *FilesChangedSensor) Kind() SensorKind { return Computational }

func (s *FilesChangedSensor) Evaluate(ctx context.Context, input SensorInput) (*SensorResult, error) {
    start := time.Now()
    passed := len(input.FilesChanged) >= s.minFiles
    summary := "ok"
    if !passed {
        summary = "no files were changed — did the agent actually do anything?"
    }
    return &SensorResult{
        Passed:     passed,
        Score:      1.0,
        Summary:    summary,
        DurationMS: time.Since(start).Milliseconds(),
    }, nil
}`}
      </CodeExample>

      <h2 id="registering-the-sensor">Registering the sensor</h2>
      <p>
        Sensors register into <code>harness.DefaultRegistry()</code> in{" "}
        <code>runner/internal/harness/registry.go</code>. The registry both
        constructs sensors on demand (<code>Build(name, config)</code>) and
        publishes a manifest the runner's heartbeat ships to the backend —
        which is how the pipeline builder populates its sensor dropdown. Skip
        the manifest and the sensor is invisible to operators even if it
        runs.
      </p>

      <CodeExample
        language="go"
        title="Adding the sensor to DefaultRegistry"
      >
        {`// runner/internal/harness/registry.go
func DefaultRegistry() *SensorRegistry {
    r := NewSensorRegistry()
    r.RegisterFactory(SensorFactory{
        Manifest:    GoTestManifest(),
        Constructor: NewGoTestSensor,
    })
    // …existing sensors…
    r.RegisterFactory(SensorFactory{
        Manifest:    FilesChangedManifest(),
        Constructor: NewFilesChangedSensor,
    })
    return r
}`}
      </CodeExample>

      <h2 id="test-and-ship">Test and ship</h2>
      <p>
        Sensor tests follow the pattern in{" "}
        <code>sensor_gotest_test.go</code> — construct the sensor, feed it a{" "}
        <code>SensorInput</code> with controlled fixture data, assert
        the resulting <code>SensorResult</code>. Keep the test hermetic:
        don't shell out to real tools, don't hit the network. Sensors run on
        every pipeline tick; a flaky sensor is worse than no sensor.
      </p>

      <p>
        Rebuild the runner: <code>cd runner && go build ./cmd/backplane-runner</code>.
        Publish the new binary (or image) to wherever your runners pull from;
        operators re-register on their next restart and the new sensor shows
        up in the pipeline builder's sensor picker, populated from the
        heartbeat manifest. Add its name to a stage's <code>sensors: []</code>{" "}
        array to start gating on it.
      </p>

      <ImportantNote title="The manifest is the contract">
        <p>
          The backend validates pipeline configs against the sensor manifest
          shipped in the last heartbeat. A stage referencing a sensor name
          the runner hasn't registered will fail validation when the config
          saves. If you add a sensor, rebuild, and deploy, make sure every
          runner rolls before you publish a pipeline that depends on the new
          sensor — a mid-rollout operator can save a config the stale runners
          can't honor.
        </p>
      </ImportantNote>

      <HonestRemark title="You can't add a sensor at runtime">
        <p>
          Operators configuring a pipeline can <em>reference</em> sensors. They
          can't <em>define</em> them. Adding a sensor requires a Go file, a
          build, and a runner redeploy. For a platform that markets itself on
          extensibility this is uncomfortable, and we know it. The compile-time
          boundary exists because sensors run with full filesystem and network
          access inside the runner process — a runtime-authored sensor is a
          sandboxing problem we haven't solved yet.
        </p>
      </HonestRemark>

      <FutureState title="The declarative sensor DSL">
        <p>
          The long-horizon goal is a YAML-authored sensor spec an operator can
          write in the pipeline builder: a command to run, an exit-code
          mapping, a regex or JSON path to extract findings, and a pass/fail
          rule. The interpreter would execute the sensor in a sandboxed
          subprocess with a fixed filesystem view and no network. This
          unblocks operator-defined <code>tsc --noEmit</code>,{" "}
          <code>ruff</code>, <code>eslint</code>, and any other toolchain
          without asking us to ship a new runner binary. Scoped, not
          scheduled — no ETA.
        </p>
      </FutureState>
    </SectionPage>
  );
}
