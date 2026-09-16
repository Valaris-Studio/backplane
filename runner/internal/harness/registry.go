// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"fmt"
	"sort"
)

// SensorConstructor creates a Sensor from optional config.
type SensorConstructor func(config map[string]any) (Sensor, error)

// SensorFactory bundles a sensor's manifest with its constructor.
// Registering a factory (rather than a bare constructor) makes the sensor
// discoverable via Catalog() — the platform uses this to populate pipeline
// builder dropdowns and validate sensor names.
type SensorFactory struct {
	Manifest    SensorManifestEntry
	Constructor SensorConstructor
}

type sensorEntry struct {
	manifest SensorManifestEntry
	ctor     SensorConstructor
}

type SensorRegistry struct {
	entries map[string]sensorEntry
}

func NewSensorRegistry() *SensorRegistry {
	return &SensorRegistry{entries: make(map[string]sensorEntry)}
}

// Register attaches a constructor with no manifest metadata.
// Sensors registered this way are buildable but absent from Catalog().
// Useful for tests and anonymous mocks; production sensors should use
// RegisterFactory so the platform can discover them.
func (r *SensorRegistry) Register(name string, ctor SensorConstructor) {
	r.entries[name] = sensorEntry{ctor: ctor}
}

// RegisterFactory attaches a sensor with its manifest, making it discoverable.
func (r *SensorRegistry) RegisterFactory(f SensorFactory) {
	r.entries[f.Manifest.Name] = sensorEntry{
		manifest: f.Manifest,
		ctor:     f.Constructor,
	}
}

func (r *SensorRegistry) Build(name string, config map[string]any) (Sensor, error) {
	entry, ok := r.entries[name]
	if !ok {
		return nil, fmt.Errorf("unknown sensor: %q", name)
	}
	return entry.ctor(config)
}

func (r *SensorRegistry) Has(name string) bool {
	_, ok := r.entries[name]
	return ok
}

// Catalog returns manifest entries for all registered factories, sorted by name.
// Entries registered via bare Register (no manifest) are excluded — the
// platform only cares about sensors it can describe to users.
// T0.4: returns a non-nil slice even when empty so the heartbeat payload
// serializes sensor_catalog as `[]` rather than `null`, which lets the
// backend clear stale catalogs on a clean heartbeat.
func (r *SensorRegistry) Catalog() []SensorManifestEntry {
	catalog := []SensorManifestEntry{}
	for _, entry := range r.entries {
		if entry.manifest.Name == "" {
			continue
		}
		catalog = append(catalog, entry.manifest)
	}
	sort.Slice(catalog, func(i, j int) bool {
		return catalog[i].Name < catalog[j].Name
	})
	return catalog
}

// DefaultRegistry returns a registry pre-loaded with all built-in sensors,
// where pr-overlap uses the default gh-CLI lister. Prefer
// DefaultRegistryWithForge so the overlap sensor honors the configured forge.
func DefaultRegistry() *SensorRegistry { return DefaultRegistryWithForge(nil) }

// DefaultRegistryWithForge returns the built-in sensor registry with the
// pr-overlap sensor routed through the supplied forge (its ListOpenChanges).
// A nil forge falls back to the gh-CLI gitManagerPRLister — behavior-identical
// to the pre-routing default — so callers without a forge stay unchanged.
func DefaultRegistryWithForge(f ChangeLister) *SensorRegistry {
	r := NewSensorRegistry()
	r.RegisterFactory(SensorFactory{
		Manifest:    GoTestManifest(),
		Constructor: NewGoTestSensor,
	})
	r.RegisterFactory(SensorFactory{
		Manifest:    ConflictCheckManifest(),
		Constructor: NewConflictCheckSensor,
	})
	overlapCtor := NewPROverlapSensor
	if f != nil {
		lister := newForgePRLister(f)
		overlapCtor = func(config map[string]any) (Sensor, error) {
			return newPROverlapSensorWithFetcher(config, lister)
		}
	}
	r.RegisterFactory(SensorFactory{
		Manifest:    PROverlapManifest(),
		Constructor: overlapCtor,
	})
	return r
}
