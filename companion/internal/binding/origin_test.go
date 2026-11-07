// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"strings"
	"testing"
)

func TestNormalizeOrigin_CanonicalizesAnAcceptedOrigin(t *testing.T) {
	for _, tc := range []struct {
		raw       string
		loopback  bool
		canonical string
	}{
		{"https://backplane.example.com", false, "https://backplane.example.com"},
		{"  https://backplane.example.com\n", false, "https://backplane.example.com"},
		{"HTTPS://BackPlane.Example.COM", false, "https://backplane.example.com"},
		{"https://backplane.example.com/", false, "https://backplane.example.com"},
		{"https://backplane.example.com:443", false, "https://backplane.example.com"},
		{"https://backplane.example.com:443/", false, "https://backplane.example.com"},
		{"https://backplane.example.com:8443", false, "https://backplane.example.com:8443"},
		{"https://backplane.example.com:80", false, "https://backplane.example.com:80"},
		{"https://backplane.example.com:1", false, "https://backplane.example.com:1"},
		{"https://backplane.example.com:65535", false, "https://backplane.example.com:65535"},
		{"https://192.0.2.10", false, "https://192.0.2.10"},
		{"https://192.0.2.10:443", false, "https://192.0.2.10"},
		{"https://[2001:DB8:0:0::1]", false, "https://[2001:db8::1]"},
		{"https://[2001:db8::1]:8443", false, "https://[2001:db8::1]:8443"},
		{"https://127.0.0.1:8443", false, "https://127.0.0.1:8443"},
		{"http://127.0.0.1:8000", true, "http://127.0.0.1:8000"},
		{"HTTP://127.0.0.1:8000/", true, "http://127.0.0.1:8000"},
		{"http://127.0.0.1:80", true, "http://127.0.0.1"},
		{"http://127.0.0.1:443", true, "http://127.0.0.1:443"},
		{"http://[::1]:8000", true, "http://[::1]:8000"},
		{"http://[0:0:0:0:0:0:0:1]:8000", true, "http://[::1]:8000"},
	} {
		got, err := NormalizeOrigin(tc.raw, tc.loopback)
		if err != nil || got != tc.canonical {
			t.Errorf("NormalizeOrigin(%q, %t) = %q, %v; want %q", tc.raw, tc.loopback, got, err, tc.canonical)
			continue
		}
		if again, err := NormalizeOrigin(got, tc.loopback); err != nil || again != got {
			t.Errorf("normalizing %q again gave %q, %v", got, again, err)
		}
	}
}

func TestNormalizeOrigin_RefusesWithAStableCode(t *testing.T) {
	// anyCode marks refusals whose code the contract leaves open; they must
	// still be refused with an origin_* code.
	const anyCode = ""
	for _, tc := range []struct {
		raw      string
		loopback bool
		code     string
	}{
		{"", false, anyCode},
		{"   ", false, anyCode},
		{"backplane.example.com", false, anyCode},
		{"https://user@backplane.example.com", false, "origin_userinfo"},
		{"https://backplane.example.com/api", false, "origin_path"},
		{"https://backplane.example.com/api/", false, "origin_path"},
		{"https://backplane.example.com//", false, "origin_path"},
		{"https://backplane.example.com?tenant=1", false, "origin_query"},
		{"https://backplane.example.com/?tenant=1", false, "origin_query"},
		{"https://backplane.example.com?", false, "origin_query"},
		{"https://backplane.example.com#top", false, anyCode},
		{"https://backplane.example.com/#top", false, anyCode},
		{"https:backplane.example.com", false, anyCode},
		{"http://backplane.example.com", false, "origin_scheme"},
		{"http://backplane.example.com", true, "origin_scheme"},
		{"http://localhost:8000", true, "origin_scheme"},
		{"http://127.0.0.1:8000", false, "origin_scheme"},
		{"http://192.0.2.10:8000", true, "origin_scheme"},
		{"ftp://backplane.example.com", false, "origin_scheme"},
		{"wss://backplane.example.com", false, "origin_scheme"},
		{"//backplane.example.com", false, "origin_scheme"},
		{"https://", false, "origin_host"},
		{"https://:8443", false, "origin_host"},
		{"https://b\u00e4ckplane.example.com", false, "origin_host"},
		{"https://b%C3%A4ckplane.example.com", false, "origin_host"},
		{"https://backplane.example.com.", false, "origin_host"},
		{"https://backplane.example.com.:8443", false, "origin_host"},
		{"https://[fe80::1%25en0]", false, "origin_host"},
		{"https://backplane.example.com:0", false, "origin_port"},
		{"https://backplane.example.com:65536", false, "origin_port"},
		{"https://backplane.example.com:99999", false, "origin_port"},
		{"https://backplane.example.com:https", false, anyCode},
		{"https://back plane.example.com", false, anyCode},
	} {
		got, err := NormalizeOrigin(tc.raw, tc.loopback)
		switch {
		case err == nil:
			t.Errorf("NormalizeOrigin(%q, %t) accepted %q", tc.raw, tc.loopback, got)
		case got != "":
			t.Errorf("NormalizeOrigin(%q, %t) refused but returned %q", tc.raw, tc.loopback, got)
		case tc.code == anyCode && codeWithPrefix(err, "origin_") == "":
			t.Errorf("NormalizeOrigin(%q, %t) = %v, want an origin_* code", tc.raw, tc.loopback, err)
		case tc.code != anyCode && !hasCode(err, tc.code):
			t.Errorf("NormalizeOrigin(%q, %t) = %v, want %s", tc.raw, tc.loopback, err, tc.code)
		}
	}
}

func TestNormalizeOrigin_NeverRepeatsCredentialsFromTheURL(t *testing.T) {
	secret := "pw-" + strings.Repeat("Z", 12)
	_, err := NormalizeOrigin("https://operator:"+secret+"@backplane.example.com", false)
	if !hasCode(err, "origin_userinfo") {
		t.Fatalf("got %v, want origin_userinfo", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("the refusal repeats the password embedded in the origin")
	}
}

func TestNormalizeInstallationID_LowercasesACanonicalUUID(t *testing.T) {
	for raw, want := range map[string]string{
		"7a1c0de5-0000-4000-8000-000000000001": "7a1c0de5-0000-4000-8000-000000000001",
		"7A1C0DE5-0000-4000-8000-00000000ABCD": "7a1c0de5-0000-4000-8000-00000000abcd",
	} {
		if got, err := NormalizeInstallationID(raw); err != nil || got != want {
			t.Errorf("NormalizeInstallationID(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
}

func TestNormalizeInstallationID_RefusesAnythingButAUUID(t *testing.T) {
	if _, err := NormalizeInstallationID(primary().InstallationID); err != nil {
		t.Fatalf("control: a canonical UUID refused: %v", err)
	}
	for _, raw := range []string{
		"",
		"install-1",
		"7a1c0de5-0000-4000-8000-00000000000",
		"7a1c0de5-0000-4000-8000-0000000000011",
		"7a1c0de5-0000-4000-8000-00000000000g",
		"7a1c0de5_0000_4000_8000_000000000001",
		"7a1c0de5-0000-4000-8000-000000000001/agents",
		"../7a1c0de5-0000-4000-8000-0000000001",
	} {
		if got, err := NormalizeInstallationID(raw); err == nil || got != "" {
			t.Errorf("NormalizeInstallationID(%q) = %q, %v; want a refusal", raw, got, err)
		}
	}
}

func TestNormalizeOwnerEmail_TrimsAndLowercases(t *testing.T) {
	for raw, want := range map[string]string{
		"owner@example.com":          "owner@example.com",
		"  Owner@Example.COM \n":     "owner@example.com",
		"First.Last@Sub.Example.Com": "first.last@sub.example.com",
	} {
		if got, err := NormalizeOwnerEmail(raw); err != nil || got != want {
			t.Errorf("NormalizeOwnerEmail(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
}

func TestNormalizeOwnerEmail_RefusesAnEmptyValueOrOtherThanOneAt(t *testing.T) {
	if _, err := NormalizeOwnerEmail(primary().OwnerEmail); err != nil {
		t.Fatalf("control: a plain address refused: %v", err)
	}
	for _, raw := range []string{"", "   ", "owner.example.com", "owner@team@example.com"} {
		if got, err := NormalizeOwnerEmail(raw); err == nil || got != "" {
			t.Errorf("NormalizeOwnerEmail(%q) = %q, %v; want a refusal", raw, got, err)
		}
	}
}
