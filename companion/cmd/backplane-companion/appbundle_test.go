// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// inAppBundle moves the harness executable to where the desktop app carries
// it and returns the bundle's Contents directory.
func inAppBundle(t *testing.T, h *harness) string {
	t.Helper()
	contents := filepath.Join(h.root, "Applications", "Backplane Companion.app", "Contents")
	executable := filepath.Join(contents, "MacOS", "backplane-companion")
	mustMkdir(t, filepath.Dir(executable))
	mustWrite(t, executable, "#!/bin/sh\n")
	os.Chmod(executable, 0o755)
	h.executable = executable
	h.app.executable = executable
	return contents
}

func TestVersion_FindsBeaconInAppBundleResources(t *testing.T) {
	h := newHarness(t)
	contents := inAppBundle(t, h)
	resources := filepath.Join(contents, "Resources", "beacon")
	mustMkdir(t, resources)
	bundled := fakeBeaconManifest(t, resources)

	view := h.version(t)
	if hooks := view.Artifacts["beacon_hooks"]; hooks.Manifest != bundled || !hooks.Verified {
		t.Fatalf("app bundle beacon-hooks: %+v", hooks)
	}
	if otelcol := view.Artifacts["beacon_otelcol"]; otelcol.Manifest != filepath.Join(resources, "otelcol.json") {
		t.Fatalf("app bundle collector manifest: %+v", otelcol)
	}
}

func TestVersion_IgnoresABeaconPlantedBesideTheExecutableInsideAppBundle(t *testing.T) {
	h := newHarness(t)
	contents := inAppBundle(t, h)
	resources := filepath.Join(contents, "Resources", "beacon")
	mustMkdir(t, resources)
	bundled := fakeBeaconManifest(t, resources)
	planted := bundledBeacon(t, h)

	hooks := h.version(t).Artifacts["beacon_hooks"]
	if hooks.Manifest != bundled || !hooks.Verified {
		t.Fatalf("a beacon directory planted in Contents/MacOS was preferred over Resources (%s): %+v", planted, hooks)
	}
}

func TestVersion_FailsClosedWhenTheAppBundleHasNoBeaconResources(t *testing.T) {
	h := newHarness(t)
	contents := inAppBundle(t, h)
	bundledBeacon(t, h)

	hooks := h.version(t).Artifacts["beacon_hooks"]
	want := filepath.Join(contents, "Resources", "beacon", "artifact.json")
	if hooks.Verified || hooks.Manifest != want || hooks.Error != "beacon_artifact_unverified" {
		t.Fatalf("a bundle without Resources/beacon must not fall back to Contents/MacOS: %+v", hooks)
	}
}

func TestVersion_ResolvesASymlinkIntoTheAppBundle(t *testing.T) {
	h := newHarness(t)
	contents := inAppBundle(t, h)
	resources := filepath.Join(contents, "Resources", "beacon")
	mustMkdir(t, resources)
	bundled := fakeBeaconManifest(t, resources)
	link := filepath.Join(h.root, "usr-local-bin", "backplane-companion")
	mustMkdir(t, filepath.Dir(link))
	if err := os.Symlink(h.executable, link); err != nil {
		t.Fatal(err)
	}
	decoy := filepath.Join(filepath.Dir(link), "beacon")
	mustMkdir(t, decoy)
	fakeBeaconManifest(t, decoy)
	h.app.executable = link

	if hooks := h.version(t).Artifacts["beacon_hooks"]; hooks.Manifest != bundled || !hooks.Verified {
		t.Fatalf("a symlink into the bundle must use the bundle's Resources: %+v", hooks)
	}
}

func TestVersion_IgnoresResourcesOutsideAnAppBundle(t *testing.T) {
	for _, layout := range []struct{ name, macOS string }{
		{"plain bin directory", filepath.Join("opt", "bin")},
		{"MacOS without Contents", filepath.Join("opt", "MacOS")},
	} {
		t.Run(layout.name, func(t *testing.T) {
			h := newHarness(t)
			executable := filepath.Join(h.root, layout.macOS, "backplane-companion")
			mustMkdir(t, filepath.Dir(executable))
			mustWrite(t, executable, "#!/bin/sh\n")
			h.executable, h.app.executable = executable, executable
			decoy := filepath.Join(filepath.Dir(filepath.Dir(executable)), "Resources", "beacon")
			mustMkdir(t, decoy)
			fakeBeaconManifest(t, decoy)

			hooks := h.version(t).Artifacts["beacon_hooks"]
			if hooks.Verified || hooks.Manifest != filepath.Join(filepath.Dir(executable), "beacon", "artifact.json") {
				t.Fatalf("a Resources directory outside an app bundle was used: %+v", hooks)
			}
		})
	}
}

func TestServiceInstall_FromAppBundleEmbedsTheBundlePathAndNoArtifactOverrides(t *testing.T) {
	h := newHarness(t)
	inAppBundle(t, h)
	h.app.goos = "darwin"
	h.app.uid = 501
	h.app.serviceRunner = &recordingRunner{}
	if err := h.run(t, "service", "install"); err != nil {
		t.Fatal(err)
	}
	plist, err := os.ReadFile(filepath.Join(h.home, "Library", "LaunchAgents", "dev.backplane.companion.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plist), "<string>"+h.executable+"</string>") {
		t.Errorf("plist does not start the bundled companion:\n%s", plist)
	}
	for _, leaked := range []string{envBeaconArtifact, envOtelcolArtifact} {
		if strings.Contains(string(plist), leaked) {
			t.Errorf("plist carries %s without it being set:\n%s", leaked, plist)
		}
	}
}
