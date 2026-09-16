// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import "testing"

func TestGoTestSensor_Name(t *testing.T) {
	sensor, err := NewGoTestSensor(nil)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	if sensor.Name() != "go-test" {
		t.Errorf("name = %q, want go-test", sensor.Name())
	}
}

func TestGoTestSensor_Kind(t *testing.T) {
	sensor, err := NewGoTestSensor(nil)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	if sensor.Kind() != Computational {
		t.Errorf("kind = %d, want Computational (%d)", sensor.Kind(), Computational)
	}
}

func TestGoTestSensor_ConfigDefaults(t *testing.T) {
	sensor, err := NewGoTestSensor(nil)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	gs := sensor.(*GoTestSensor)
	if gs.Packages() != "./..." {
		t.Errorf("packages = %q, want ./...", gs.Packages())
	}
	if gs.Timeout() != "120s" {
		t.Errorf("timeout = %q, want 120s", gs.Timeout())
	}
	if gs.Tags() != "" {
		t.Errorf("tags = %q, want empty", gs.Tags())
	}
}

func TestGoTestSensor_ConfigOverride(t *testing.T) {
	config := map[string]any{
		"packages": "./cmd/...",
		"timeout":  "60s",
		"tags":     "integration",
	}
	sensor, err := NewGoTestSensor(config)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	gs := sensor.(*GoTestSensor)
	if gs.Packages() != "./cmd/..." {
		t.Errorf("packages = %q, want ./cmd/...", gs.Packages())
	}
	if gs.Timeout() != "60s" {
		t.Errorf("timeout = %q, want 60s", gs.Timeout())
	}
	if gs.Tags() != "integration" {
		t.Errorf("tags = %q, want integration", gs.Tags())
	}
}

func TestGoTestSensor_ConfigPartialOverride(t *testing.T) {
	config := map[string]any{
		"timeout": "30s",
	}
	sensor, err := NewGoTestSensor(config)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	gs := sensor.(*GoTestSensor)
	if gs.Packages() != "./..." {
		t.Errorf("packages = %q, want ./... (default)", gs.Packages())
	}
	if gs.Timeout() != "30s" {
		t.Errorf("timeout = %q, want 30s", gs.Timeout())
	}
	if gs.Tags() != "" {
		t.Errorf("tags = %q, want empty (default)", gs.Tags())
	}
}

func TestGoTestManifest_Shape(t *testing.T) {
	m := GoTestManifest()

	if m.Name != "go-test" {
		t.Errorf("name = %q, want go-test", m.Name)
	}
	if m.Kind != SensorKindComputational {
		t.Errorf("kind = %q, want %q", m.Kind, SensorKindComputational)
	}
	if m.Description == "" {
		t.Error("description should be set")
	}
	// DefaultConfig must mirror NewGoTestSensor's zero-config defaults.
	if m.DefaultConfig["packages"] != "./..." {
		t.Errorf("default packages = %v, want ./...", m.DefaultConfig["packages"])
	}
	if m.DefaultConfig["timeout"] != "120s" {
		t.Errorf("default timeout = %v, want 120s", m.DefaultConfig["timeout"])
	}
	if m.DefaultConfig["tags"] != "" {
		t.Errorf("default tags = %v, want empty", m.DefaultConfig["tags"])
	}
}
