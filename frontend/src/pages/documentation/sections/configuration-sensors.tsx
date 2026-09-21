// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Source: runner/internal/harness/* (sensor registry + the three shipped sensors),
// backend/app/services/pipeline_config_validation.py (_validate_sensors),
// docs/research/runner-pipeline-internals.md §4.

import { SectionPage } from "../shell/SectionPage";
import { CodeExample, FutureState, HonestRemark } from "../callouts";

export function ConfigurationSensors() {
  return (
    <SectionPage title="Sensors" eyebrow="Configuration">
      <p>
        A <strong>sensor</strong> is a platform-side check that inspects the
        output of a stage and decides whether the stage is allowed to progress.
        Sensors are the feedback half of the harness — the LLM produces a
        change, the sensor grades it, and the result feeds into the stage's
        <code> on_success</code> / <code>on_failure</code> action. They are the
        only place in the pipeline where a deterministic verdict (test passed,
        merge conflict detected) can override the LLM's own claim that the work
        is done.
      </p>
      <p>
        The runner registers its sensor catalog on every heartbeat — the
        backend stores it on <code>agents.sensor_catalog</code> and the pipeline
        validator rejects <code>pipeline_config</code> that references a sensor
        name no active runner has declared. Operators configure sensors per
        stage; the runner builds them from the manifest and runs them after the
        LLM call.
      </p>

      <h2 id="shipped-catalog">The shipped catalog</h2>
      <p>
        Three sensors ship with the Go runner today, registered in
        <code> runner/internal/harness/registry.go</code> and published to the
        platform via the heartbeat catalog. The <code>kind</code> field is the
        important distinction: <em>computational</em> sensors are deterministic
        and fast (linters, test runners, merge-conflict checks).{" "}
        <em>Inferential</em> sensors use an LLM or a remote API and produce a
        probabilistic verdict that can vary between runs.
      </p>

      <CodeExample
        language="json"
        title="The three sensors a runner publishes today"
      >
        {`[
  {
    "name": "go-test",
    "kind": "computational",
    "default_config": { "packages": "./...", "timeout": "120s", "tags": "" },
    "description": "Runs Go tests via 'go test -json' and fails on any test failure."
  },
  {
    "name": "conflict-check",
    "kind": "computational",
    "default_config": { "default_branch": "main", "timeout": "30s" },
    "description": "Runs 'git merge-tree' against the default branch to detect merge conflicts before push. Emits one finding per conflicted file."
  },
  {
    "name": "pr-overlap",
    "kind": "inferential",
    "default_config": { "repo_slug": "", "default_branch": "main", "ignore_pr_number": 0, "timeout": "30s" },
    "description": "Flags open PRs that touch the same files as the current change."
  }
]`}
      </CodeExample>

      <p>
        The list is intentionally short. <code>go-test</code> covers the
        language-specific test gate for the repos Backplane ships against today;
        a TypeScript equivalent and a <code>golangci-lint</code> sensor are
        tracked but not yet written. The inferential half is represented by{" "}
        <code>pr-overlap</code> and, at the pipeline level, by the reviewer
        role itself — which is an LLM-driven sensor in everything but name.
      </p>

      <h2 id="attaching-sensors-to-a-stage">Attaching sensors to a stage</h2>
      <p>
        A stage carries an optional <code>sensors</code> array. Each entry is a
        sensor <code>name</code> from the catalog plus any config overrides.
        The runner builds the sensor from the manifest's default config,
        overlays the stage-level overrides, and invokes{" "}
        <code>Evaluate(ctx, input)</code> after the LLM call. A{" "}
        <code>SensorResult</code> carries a <code>Passed</code> boolean, an
        optional score, a list of findings, a human-readable summary, and a
        duration.
      </p>

      <CodeExample
        language="json"
        title="A stage with two sensors configured"
      >
        {`{
  "role": "implementer",
  "llm": { "enabled": true, "stage": "implement", "post_process_kind": "writes_code" },
  "sensors": [
    { "name": "go-test", "config": { "packages": "./backend/..." } },
    { "name": "conflict-check", "config": { "default_branch": "main" } }
  ],
  "on_success": { "move_to_column_type": "review" },
  "on_failure": { "move_to_column_type": "backlog", "add_label": "sensor-failed" }
}`}
      </CodeExample>

      <h2 id="fail-open-vs-fail-closed">Fail-open vs fail-closed</h2>
      <p>
        If a sensor returns an error (the subprocess couldn't run, the remote
        API timed out, the binary wasn't in <code>PATH</code>), the runner logs
        it and treats the stage as failing — the{" "}
        <code>on_failure</code> action applies. This is a deliberate{" "}
        <em>fail-closed</em> default: we refuse to promote a change past a gate
        we couldn't evaluate. The alternative — silently passing when the gate
        is broken — is a correctness bug that hides until the first real
        regression slips through.
      </p>
      <p>
        If a sensor returns cleanly with <code>Passed: false</code>, the
        failure is the sensor's actual verdict and the same path runs. The
        findings are attached to the execution record so the operator can
        inspect them in the UI without grepping the runner logs.
      </p>

      <p>The sensor picker only lists sensors the active runner has published. An unrecognized name fails validation at save time.</p>

      <HonestRemark title="The catalog is published by runners, not the backend">
        If you hit "save" on a stage referencing <code>tsc-noemit</code> and
        see "unknown sensor name," the fix is not in the platform — it is in
        whichever runner build you expected to own that sensor. The backend
        computes the known set from the <em>union</em> of sensor catalogs
        across active agents in the workspace. A runner that last heartbeated
        three days ago still counts. Restart the runner you expected to supply
        the sensor and the catalog refreshes on the next heartbeat.
      </HonestRemark>

      <FutureState title="A declarative sensor DSL is on the roadmap, not shipped">
        Adding a new sensor today means writing Go: implement the{" "}
        <code>Sensor</code> interface, register a factory in the harness
        registry, cut a runner release. That is a higher bar than the vision
        document describes. The longer-horizon ambition is a declarative
        sensor spec — author the check in YAML or JSON, publish it to the
        platform, have any runner pick it up — so a non-Go operator can add a
        gate without a binary rebuild. Tracked; not imminent.
      </FutureState>
    </SectionPage>
  );
}
