// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package policy_test

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

const installationOnly = `{"installation":{"id":"i1","paused":false,"auto_match_repos":false,"enabled_agents":null,"exclude_globs":[]},"mappings":[],"repo_catalog":[]`

func decodePolicy(t *testing.T, document string) policy.Policy {
	t.Helper()
	var decoded policy.Policy
	if err := json.Unmarshal([]byte(document), &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func offerDocument(t *testing.T) string {
	return string(contracttest.WireExample(t, "policy-rich-capture-offer.json").Body)
}

// R3-5: an explicit null (a server that knows rich capture and offers none)
// and an absent member (a server from before it) are different evidence.
func TestRichCaptureRecordsWhetherTheMemberWasPresent(t *testing.T) {
	absent := decodePolicy(t, installationOnly+`}`)
	if absent.RichCapture.Present || absent.RichCapture.Offer != nil {
		t.Fatalf("absent member decoded as %+v", absent.RichCapture)
	}
	null := decodePolicy(t, installationOnly+`,"rich_capture":null}`)
	if !null.RichCapture.Present || null.RichCapture.Offer != nil {
		t.Fatalf("explicit null decoded as %+v", null.RichCapture)
	}
	offered := decodePolicy(t, installationOnly+`,"rich_capture":`+offerDocument(t)+`}`)
	if !offered.RichCapture.Present || offered.RichCapture.Offer == nil || len(offered.RichCapture.Offer.RichMappings) != 1 {
		t.Fatalf("offer decoded as %+v", offered.RichCapture)
	}
}

// The cache keeps the distinction across a restart.
func TestCachedPolicyKeepsNullAbsentAndOfferApart(t *testing.T) {
	for name, member := range map[string]string{"absent": "", "null": `,"rich_capture":null`, "offer": `,"rich_capture":` + offerDocument(t)} {
		t.Run(name, func(t *testing.T) {
			wantPresent, wantOffer := name != "absent", name == "offer"
			fresh := decodePolicy(t, installationOnly+member+`}`)
			path := filepath.Join(t.TempDir(), "policy.json")
			if err := policy.Save(path, policy.Cached{Policy: fresh, RefreshedAt: time.Now()}); err != nil {
				t.Fatal(err)
			}
			loaded, err := policy.Load(path)
			if err != nil {
				t.Fatal(err)
			}
			got := loaded.Policy.RichCapture
			if got.Present != wantPresent || (got.Offer != nil) != wantOffer {
				t.Fatalf("cached %+v, want present %v offer %v", got, wantPresent, wantOffer)
			}
		})
	}
}

// An offer the contract forbids is never acted on: the device captures no
// rich content, while the rest of the policy still applies.
func TestAnInvalidOfferIsPresentButOffersNothing(t *testing.T) {
	for _, wire := range contracttest.InvalidWireExamples(t) {
		if wire.Model != "RichCaptureOffer" {
			continue
		}
		t.Run(wire.Name, func(t *testing.T) {
			decoded := decodePolicy(t, installationOnly+`,"rich_capture":`+string(wire.Body)+`}`)
			if !decoded.RichCapture.Present || decoded.RichCapture.Offer != nil {
				t.Fatalf("%s (%s) was accepted: %+v", wire.Name, wire.Why, decoded.RichCapture)
			}
			if decoded.Installation.ID != "i1" {
				t.Fatal("the rest of the policy was lost")
			}
		})
	}
	unknownVersion := strings.Replace(offerDocument(t), `"version": 1`, `"version": 2`, 1)
	if decoded := decodePolicy(t, installationOnly+`,"rich_capture":`+unknownVersion+`}`); decoded.RichCapture.Offer != nil {
		t.Fatal("an offer of an unknown contract version was accepted")
	}
}

func TestRichSinceNamesOnlyListedMappings(t *testing.T) {
	offered := decodePolicy(t, installationOnly+`,"rich_capture":`+offerDocument(t)+`}`)
	since, ok := offered.RichSince("3d6a1f4e-2b7c-4e8d-9f01-23456789abcd")
	if !ok || !since.Equal(time.Date(2026, 10, 8, 13, 58, 41, 0, time.UTC)) {
		t.Fatalf("RichSince = %v, %v", since, ok)
	}
	if _, ok := offered.RichSince("another-mapping"); ok {
		t.Fatal("an unlisted mapping captures rich")
	}
	if _, ok := decodePolicy(t, installationOnly+`,"rich_capture":null}`).RichSince("3d6a1f4e-2b7c-4e8d-9f01-23456789abcd"); ok {
		t.Fatal("null offers nothing")
	}
}

// The device declares within the smaller of the offer's limits and its own.
// Chunk geometry is not among them: each upload slot states its own.
func TestEffectiveLimitsAreTheSmallerOfOfferAndDevice(t *testing.T) {
	offer := policy.RichCaptureOffer{Version: 1, Limits: policy.DeviceRichLimits}
	offer.Limits.MaxInlineBodyBytes = 1024
	offer.Limits.MaxTextBodyBytes = 64 << 20
	offer.Limits.MaxContentsPerRecord = 100
	limits := offer.EffectiveLimits()
	if limits.MaxInlineBodyBytes != 1024 || limits.MaxContentsPerRecord != 100 {
		t.Fatalf("the offer's smaller limits were not taken: %+v", limits)
	}
	if limits.MaxTextBodyBytes != policy.DeviceRichLimits.MaxTextBodyBytes {
		t.Fatalf("a limit above the device's own was taken: %+v", limits)
	}
}
