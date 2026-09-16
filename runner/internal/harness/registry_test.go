// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"context"
	"testing"
)

func TestSensorRegistry_RegisterAndBuild(t *testing.T) {
	r := NewSensorRegistry()
	r.Register("mock", func(config map[string]any) (Sensor, error) {
		return &mockSensor{name: "mock"}, nil
	})

	sensor, err := r.Build("mock", nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if sensor.Name() != "mock" {
		t.Errorf("name = %q, want mock", sensor.Name())
	}
}

func TestSensorRegistry_BuildUnknown(t *testing.T) {
	r := NewSensorRegistry()
	_, err := r.Build("nonexistent", nil)
	if err == nil {
		t.Fatal("expected error for unknown sensor")
	}
}

func TestSensorRegistry_Has(t *testing.T) {
	r := NewSensorRegistry()
	r.Register("exists", func(config map[string]any) (Sensor, error) {
		return &mockSensor{name: "exists"}, nil
	})

	if !r.Has("exists") {
		t.Error("Has(exists) = false, want true")
	}
	if r.Has("missing") {
		t.Error("Has(missing) = true, want false")
	}
}

func TestDefaultRegistry_HasGoTest(t *testing.T) {
	r := DefaultRegistry()
	if !r.Has("go-test") {
		t.Fatal("default registry missing go-test sensor")
	}
	sensor, err := r.Build("go-test", nil)
	if err != nil {
		t.Fatalf("build go-test: %v", err)
	}
	if sensor.Name() != "go-test" {
		t.Errorf("name = %q, want go-test", sensor.Name())
	}
}

func TestSensorRegistry_Catalog_Empty(t *testing.T) {
	r := NewSensorRegistry()
	catalog := r.Catalog()
	if len(catalog) != 0 {
		t.Errorf("empty registry catalog len = %d, want 0", len(catalog))
	}
}

func TestDefaultRegistry_CatalogContainsGoTest(t *testing.T) {
	r := DefaultRegistry()
	catalog := r.Catalog()

	var goTest *SensorManifestEntry
	for i := range catalog {
		if catalog[i].Name == "go-test" {
			goTest = &catalog[i]
			break
		}
	}
	if goTest == nil {
		t.Fatalf("catalog missing go-test entry: %+v", catalog)
	}
	if goTest.Kind != SensorKindComputational {
		t.Errorf("kind = %q, want %q", goTest.Kind, SensorKindComputational)
	}
	if goTest.Description == "" {
		t.Error("description should be set")
	}
	if goTest.DefaultConfig["packages"] != "./..." {
		t.Errorf("default_config.packages = %v, want ./...", goTest.DefaultConfig["packages"])
	}
	if goTest.DefaultConfig["timeout"] != "120s" {
		t.Errorf("default_config.timeout = %v, want 120s", goTest.DefaultConfig["timeout"])
	}
	if _, ok := goTest.DefaultConfig["tags"]; !ok {
		t.Error("default_config should contain tags key")
	}
}

func TestSensorRegistry_Catalog_SortedByName(t *testing.T) {
	// Deterministic ordering lets callers rely on output shape (e.g. dropdown UI,
	// dedup hashing). Registry uses a map; Catalog must sort before returning.
	r := NewSensorRegistry()
	r.RegisterFactory(SensorFactory{
		Manifest:    SensorManifestEntry{Name: "zeta", Kind: SensorKindComputational},
		Constructor: func(_ map[string]any) (Sensor, error) { return &mockSensor{name: "zeta"}, nil },
	})
	r.RegisterFactory(SensorFactory{
		Manifest:    SensorManifestEntry{Name: "alpha", Kind: SensorKindInferential},
		Constructor: func(_ map[string]any) (Sensor, error) { return &mockSensor{name: "alpha"}, nil },
	})

	catalog := r.Catalog()
	if len(catalog) != 2 {
		t.Fatalf("catalog len = %d, want 2", len(catalog))
	}
	if catalog[0].Name != "alpha" || catalog[1].Name != "zeta" {
		t.Errorf("catalog not sorted: %v", catalog)
	}
}

func TestDefaultRegistry_IncludesConflictCheck(t *testing.T) {
	r := DefaultRegistry()
	if !r.Has("conflict-check") {
		t.Fatal("default registry missing conflict-check sensor")
	}
}

func TestDefaultRegistry_IncludesPROverlap(t *testing.T) {
	r := DefaultRegistry()
	if !r.Has("pr-overlap") {
		t.Fatal("default registry missing pr-overlap sensor")
	}
}

func TestDefaultRegistry_Catalog_ContainsAllThreeSensors(t *testing.T) {
	r := DefaultRegistry()
	catalog := r.Catalog()

	names := make([]string, len(catalog))
	for i, e := range catalog {
		names[i] = e.Name
	}
	// Catalog is name-sorted, so conflict-check < go-test < pr-overlap.
	want := []string{"conflict-check", "go-test", "pr-overlap"}
	if len(names) != len(want) {
		t.Fatalf("catalog names = %v, want %v", names, want)
	}
	for i, n := range want {
		if names[i] != n {
			t.Errorf("catalog[%d] = %q, want %q (full: %v)", i, names[i], n, names)
		}
	}
}

func TestSensorRegistry_RegisterFactory_BuildsSensor(t *testing.T) {
	r := NewSensorRegistry()
	r.RegisterFactory(SensorFactory{
		Manifest: SensorManifestEntry{
			Name:          "custom",
			Kind:          SensorKindComputational,
			DefaultConfig: map[string]any{"x": 1},
		},
		Constructor: func(_ map[string]any) (Sensor, error) {
			return &mockSensor{name: "custom"}, nil
		},
	})

	sensor, err := r.Build("custom", nil)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if sensor.Name() != "custom" {
		t.Errorf("name = %q, want custom", sensor.Name())
	}
	if !r.Has("custom") {
		t.Error("Has(custom) = false after RegisterFactory")
	}
}

// mockSensor is a minimal Sensor for registry tests.
type mockSensor struct {
	name string
}

func (m *mockSensor) Name() string     { return m.name }
func (m *mockSensor) Kind() SensorKind { return Computational }
func (m *mockSensor) Evaluate(_ context.Context, _ SensorInput) (*SensorResult, error) {
	return &SensorResult{Passed: true, Summary: "mock"}, nil
}
