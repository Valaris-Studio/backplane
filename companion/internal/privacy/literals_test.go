// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"os"
	"regexp"
	"testing"
)

// The literal skip in Redact holds only while every secret pattern of
// asymptoteobserve.RedactString needs one of secretLiterals; it was checked
// against this version. Test binaries carry no dependency versions, so the
// module's own go.mod is read.
const reviewedRedactorVersion = "v0.0.0-20260923223037-b17031414618"

var redactorRequire = regexp.MustCompile(`(?m)^\s*(?:require\s+)?github\.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve\s+(v\S+)`)

// redactorReplaced matches a replace directive naming the redactor, in a
// block or on its own line: it would swap the reviewed code unseen.
var redactorReplaced = regexp.MustCompile(`(?m)^\s*(?:replace\s*\(?\s*)?github\.com/asymptote-labs/agent-beacon(?:/pkg/asymptoteobserve)?\S*\s*(?:v\S+\s*)?=>`)

func TestAReplacedRedactorIsCaught(t *testing.T) {
	for _, module := range []string{
		"replace github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve => ../fork",
		"replace (\n\tgithub.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve v0.0.0-x => example.com/other v1.0.0\n)",
	} {
		if !redactorReplaced.MatchString(module) {
			t.Errorf("not caught: %q", module)
		}
	}
	if redactorReplaced.MatchString("require github.com/asymptote-labs/agent-beacon/pkg/asymptoteobserve v0.0.0-x") {
		t.Error("a require taken for a replace")
	}
}

func TestTheSecretLiteralsWereReviewedAgainstTheRedactorInUse(t *testing.T) {
	module, err := os.ReadFile("../../go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if redactorReplaced.Match(module) {
		t.Fatal("go.mod replaces asymptoteobserve: the secret literals were reviewed against the pinned release, not a replacement; re-verify them before allowing it")
	}
	match := redactorRequire.FindSubmatch(module)
	if match == nil {
		t.Fatal("go.mod no longer requires asymptoteobserve")
	}
	if version := string(match[1]); version != reviewedRedactorVersion {
		t.Fatalf("asymptoteobserve is %s, reviewed %s: before bumping, re-verify that every pattern of RedactString (and its assigned-secret pattern) needs one of secretLiterals, then update reviewedRedactorVersion", version, reviewedRedactorVersion)
	}
}
