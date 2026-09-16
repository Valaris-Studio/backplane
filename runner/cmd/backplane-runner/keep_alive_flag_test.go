// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"flag"
	"testing"
)

// -keep-alive precedence (card 5ffe97cf). A boolean flag's zero value is
// indistinguishable from an explicit `-keep-alive=false`, so "flag wins" alone
// would make every bare `-loop` silently clear a profile's keep_alive: true.
// Only an explicitly PASSED flag overrides the YAML.

func TestResolveKeepAlive(t *testing.T) {
	cases := []struct {
		name        string
		fromYAML    bool
		flagValue   bool
		flagPassed  bool
		want        bool
		explanation string
	}{
		{
			name: "flag absent keeps YAML off", fromYAML: false, flagValue: false, flagPassed: false, want: false,
			explanation: "the default: exit on loop-off, exactly as before this card",
		},
		{
			name: "flag absent keeps YAML on", fromYAML: true, flagValue: false, flagPassed: false, want: true,
			explanation: "the regression this function exists to prevent — a bare -loop must not clear a profile's keep_alive",
		},
		{
			name: "explicit true overrides YAML off", fromYAML: false, flagValue: true, flagPassed: true, want: true,
			explanation: "one-off opt-in without editing the profile",
		},
		{
			name: "explicit false overrides YAML on", fromYAML: true, flagValue: false, flagPassed: true, want: false,
			explanation: "-keep-alive=false is how an operator opts a keep-alive profile out for one run",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveKeepAlive(tc.fromYAML, tc.flagValue, tc.flagPassed)
			if got != tc.want {
				t.Errorf("resolveKeepAlive(yaml=%v, flag=%v, passed=%v) = %v, want %v — %s",
					tc.fromYAML, tc.flagValue, tc.flagPassed, got, tc.want, tc.explanation)
			}
		})
	}
}

// flagWasPassed is what makes the distinction above observable at all: it must
// report on ACTUAL command-line presence, not on the flag's value.
func TestFlagWasPassed_ReportsPresenceNotValue(t *testing.T) {
	orig := flag.CommandLine
	t.Cleanup(func() { flag.CommandLine = orig })

	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	flag.Bool("keep-alive", false, "")
	flag.Bool("other", false, "")
	// Explicitly FALSE — value-based detection would miss this.
	if err := flag.CommandLine.Parse([]string{"-keep-alive=false"}); err != nil {
		t.Fatalf("parse: %v", err)
	}

	if !flagWasPassed("keep-alive") {
		t.Error("flagWasPassed(\"keep-alive\") = false for an explicitly-passed -keep-alive=false")
	}
	if flagWasPassed("other") {
		t.Error("flagWasPassed(\"other\") = true for a flag that was never passed")
	}
}
