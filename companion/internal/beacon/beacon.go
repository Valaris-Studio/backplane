// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package beacon runs the pinned, unmodified beacon-hooks executable to
// normalize native agent observations into Beacon events.
package beacon

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// Commit is the Beacon source revision this companion is built against; it
// must match beacon-source.json and the asymptoteobserve module pin.
const Commit = "b17031414618cf86f7aad2b485935e548e8a8e63"

const (
	maxEventBytes    = 64 << 10
	maxEvents        = 32
	processTimeout   = 10 * time.Second
	processWaitDelay = 500 * time.Millisecond
	maxManifestSize  = 64 << 10
)

var (
	ErrUnverified = errors.New("beacon_artifact_unverified")
	// ErrNormalize is a deterministic rejection: retrying the same payload
	// would fail the same way.
	ErrNormalize = errors.New("beacon_normalization_failed")
	// ErrNoEvents means Beacon ran cleanly but maps this event to nothing
	// (e.g. a Pi user message_end); there is nothing to upload.
	ErrNoEvents = errors.New("beacon_no_events")
	// ErrInterrupted means Beacon was cancelled or timed out; retry later.
	ErrInterrupted = errors.New("beacon_normalization_interrupted")
)

type Manifest struct {
	Path         string `json:"path"`
	SHA256       string `json:"sha256"`
	SourceCommit string `json:"source_commit"`
	GOOS         string `json:"goos,omitempty"`
	GOARCH       string `json:"goarch,omitempty"`
}

type Runner struct {
	executable string
	sha256     string
	workDir    string
}

// VerifyExecutable checks a manifest built from the pinned Beacon source
// (e.g. the beacon-otelcol collector) and returns its executable's path.
func VerifyExecutable(manifestPath string) (string, error) {
	manifest, err := Verify(manifestPath)
	return manifest.Path, err
}

// Verify reads a manifest and checks its executable against it; the
// returned manifest carries the executable's absolute path.
func Verify(manifestPath string) (Manifest, error) {
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return Manifest{}, err
	}
	return manifest, manifest.verify()
}

func readManifest(manifestPath string) (Manifest, error) {
	data, err := os.ReadFile(manifestPath)
	if err != nil || len(data) > maxManifestSize {
		return Manifest{}, fmt.Errorf("%w: cannot read manifest", ErrUnverified)
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("%w: invalid manifest", ErrUnverified)
	}
	if manifest.Path != "" && !filepath.IsAbs(manifest.Path) {
		manifest.Path = filepath.Join(filepath.Dir(manifestPath), manifest.Path)
	}
	return manifest, nil
}

// Load reads the artifact manifest and verifies the executable's checksum
// once. Callers verify at daemon start, never per event.
func Load(manifestPath, workDir string) (*Runner, error) {
	manifest, err := readManifest(manifestPath)
	if err != nil {
		return nil, err
	}
	if err := manifest.verify(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(workDir) {
		return nil, fmt.Errorf("%w: work directory must be absolute", ErrUnverified)
	}
	return &Runner{executable: manifest.Path, sha256: manifest.SHA256, workDir: workDir}, nil
}

func (m Manifest) verify() error {
	switch {
	case m.SourceCommit != Commit:
		return fmt.Errorf("%w: unsupported source revision", ErrUnverified)
	case !filepath.IsAbs(m.Path):
		return fmt.Errorf("%w: executable path missing", ErrUnverified)
	case m.GOOS != "" && m.GOOS != runtime.GOOS, m.GOARCH != "" && m.GOARCH != runtime.GOARCH:
		return fmt.Errorf("%w: artifact built for another platform", ErrUnverified)
	}
	sum, err := fileSHA256(m.Path)
	if err != nil {
		return fmt.Errorf("%w: cannot read executable", ErrUnverified)
	}
	if sum != m.SHA256 {
		return fmt.Errorf("%w: checksum mismatch", ErrUnverified)
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func (r *Runner) SHA256() string { return r.sha256 }

type Request struct {
	Platform  string
	Command   string
	Event     string
	SessionID string
	Cwd       string
	Payload   map[string]any
}

type Result struct {
	Events        []json.RawMessage
	SchemaVersion string
}

func (r *Runner) Normalize(ctx context.Context, request Request) (Result, error) {
	scratch, err := os.MkdirTemp(r.workDir, "beacon-*")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(scratch)
	input, err := json.Marshal(request.Payload)
	if err != nil {
		return Result{}, fmt.Errorf("%w: cannot encode payload", ErrNormalize)
	}
	logPath := filepath.Join(scratch, "runtime.jsonl")
	processCtx, cancel := context.WithTimeout(ctx, processTimeout)
	defer cancel()
	process := exec.CommandContext(processCtx, r.executable, request.Command, "--platform", request.Platform, "--log", logPath)
	process.Dir = scratch
	hideConsole(process)
	if info, err := os.Stat(request.Cwd); err == nil && info.IsDir() {
		process.Dir = request.Cwd
	}
	process.Env = RestrictedEnvironment(scratch)
	process.Stdin = bytes.NewReader(input)
	process.Stdout = io.Discard
	diagnostics := &countingWriter{}
	process.Stderr = diagnostics
	// Stop waiting for output pipes that a killed process's children still hold.
	process.WaitDelay = processWaitDelay
	if err := process.Run(); err != nil {
		if processCtx.Err() != nil {
			return Result{}, fmt.Errorf("%w: %v", ErrInterrupted, processCtx.Err())
		}
		return Result{}, fmt.Errorf("%w: process failed", ErrNormalize)
	}
	// Any diagnostic means Beacon may have degraded silently; drop the event.
	if diagnostics.size > 0 {
		return Result{}, fmt.Errorf("%w: diagnostic reported", ErrNormalize)
	}
	log, err := os.Open(logPath)
	if errors.Is(err, os.ErrNotExist) {
		return Result{}, ErrNoEvents
	}
	if err != nil {
		return Result{}, fmt.Errorf("%w: cannot read events", ErrNormalize)
	}
	defer log.Close()
	return readEvents(log, request.SessionID)
}

// RestrictedEnvironment gives a Beacon executable a private HOME and nothing
// else of the operator's environment, so it can never read or write the
// operator's Beacon, cloud or agent state.
func RestrictedEnvironment(home string) []string {
	environment := []string{"HOME=" + home, "USERPROFILE=" + home, "BEACON_ENDPOINT_MODE=1", "BEACON_DISABLE_GIT_METADATA=1"}
	for _, key := range []string{"PATH", "SYSTEMROOT", "WINDIR"} {
		if value := os.Getenv(key); value != "" {
			environment = append(environment, key+"="+value)
		}
	}
	return environment
}

type countingWriter struct{ size int }

func (w *countingWriter) Write(data []byte) (int, error) {
	w.size += len(data)
	return len(data), nil
}

func readEvents(input io.Reader, sessionID string) (Result, error) {
	reader := bufio.NewReaderSize(input, 128<<10)
	result := Result{}
	for {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, io.EOF) && len(line) == 0 {
			break
		}
		if err != nil || len(line) > maxEventBytes {
			return Result{}, fmt.Errorf("%w: partial or oversized record", ErrNormalize)
		}
		var event struct {
			SchemaVersion string `json:"schema_version"`
			Event         struct {
				Action string `json:"action"`
			} `json:"event"`
			Session struct {
				ID string `json:"id"`
			} `json:"session"`
		}
		if err := json.Unmarshal(line, &event); err != nil || event.Event.Action == "" {
			return Result{}, fmt.Errorf("%w: invalid event", ErrNormalize)
		}
		if event.Session.ID != sessionID {
			return Result{}, fmt.Errorf("%w: native session identity lost", ErrNormalize)
		}
		if result.SchemaVersion == "" {
			result.SchemaVersion = event.SchemaVersion
		} else if result.SchemaVersion != event.SchemaVersion {
			return Result{}, fmt.Errorf("%w: mixed schema versions", ErrNormalize)
		}
		stripped, err := StripDeviceIdentity(line)
		if err != nil {
			return Result{}, fmt.Errorf("%w: invalid event", ErrNormalize)
		}
		result.Events = append(result.Events, stripped)
		if len(result.Events) > maxEvents {
			return Result{}, fmt.Errorf("%w: too many events", ErrNormalize)
		}
	}
	if len(result.Events) == 0 {
		return Result{}, ErrNoEvents
	}
	return result, nil
}

// StripDeviceIdentity removes the local account and host name Beacon adds
// to every event; sessions are attributed through the device credential.
func StripDeviceIdentity(line []byte) (json.RawMessage, error) {
	var event map[string]any
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.UseNumber()
	if err := decoder.Decode(&event); err != nil {
		return nil, err
	}
	delete(event, "user")
	if endpoint, ok := event["endpoint"].(map[string]any); ok {
		delete(endpoint, "hostname")
		if len(endpoint) == 0 {
			delete(event, "endpoint")
		}
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		return nil, err
	}
	return json.RawMessage(bytes.TrimSpace(buffer.Bytes())), nil
}
