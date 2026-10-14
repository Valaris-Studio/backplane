// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const validDeviceToken = "bpc_synthetic_device_token_0123456789"

func anonymousClient(t *testing.T, handler http.HandlerFunc) *uplink.Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := uplink.New(uplink.Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

// pageOn is the verification page on the endpoint's own origin.
func pageOn(r *http.Request) string { return "http://" + r.Host + "/companion/pair" }

func startedBody(verificationURI string) map[string]any {
	return map[string]any{
		"device_code":               "dc_synthetic",
		"user_code":                 "BCDF-GHJK",
		"verification_uri":          verificationURI,
		"verification_uri_complete": verificationURI + "#code=BCDF-GHJK",
		"interval":                  5,
		"expires_in":                600,
	}
}

func TestStartPairing_SendsNoCredentialAndReadsTheCodes(t *testing.T) {
	var received map[string]any
	client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/companion/pairing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("pairing start carried a credential: %q", r.Header.Get("Authorization"))
		}
		json.NewDecoder(r.Body).Decode(&received)
		json.NewEncoder(w).Encode(startedBody(pageOn(r)))
	})
	started, err := client.StartPairing(context.Background(), uplink.PairingRequest{Name: "Studio Mac", Platform: "darwin", Arch: "arm64", CompanionVersion: "1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	if started.UserCode != "BCDF-GHJK" || started.DeviceCode != "dc_synthetic" || started.Interval != 5 || started.ExpiresIn != 600 {
		t.Fatalf("started = %+v", started)
	}
	if !strings.HasSuffix(started.VerificationURIComplete, "/companion/pair#code=BCDF-GHJK") {
		t.Fatalf("verification_uri_complete = %q", started.VerificationURIComplete)
	}
	if received["name"] != "Studio Mac" || received["platform"] != "darwin" || received["arch"] != "arm64" || received["companion_version"] != "1.2.3" {
		t.Fatalf("request body = %v", received)
	}
}

func TestStartPairing_OmitsAnEmptyName(t *testing.T) {
	var received map[string]any
	client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&received)
		json.NewEncoder(w).Encode(startedBody(pageOn(r)))
	})
	if _, err := client.StartPairing(context.Background(), uplink.PairingRequest{Platform: "linux", Arch: "amd64", CompanionVersion: "1"}); err != nil {
		t.Fatal(err)
	}
	if _, present := received["name"]; present {
		t.Fatalf("an empty name must be omitted so the server picks the neutral default: %v", received)
	}
}

func TestStartPairing_RejectsAVerificationURIThatIsNotAWebPage(t *testing.T) {
	for _, uri := range []string{"javascript:alert(1)", "file:///etc/passwd", "/companion/pair", "https://"} {
		client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(startedBody(uri))
		})
		if _, err := client.StartPairing(context.Background(), uplink.PairingRequest{Platform: "linux", Arch: "amd64", CompanionVersion: "1"}); !errors.Is(err, uplink.ErrInvalidResponse) {
			t.Errorf("accepted verification_uri %q: %v", uri, err)
		}
	}
}

func TestStartPairing_RejectsAMalformedUserCode(t *testing.T) {
	client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
		body := startedBody(pageOn(r))
		body["user_code"] = "AEIO-U123"
		json.NewEncoder(w).Encode(body)
	})
	if _, err := client.StartPairing(context.Background(), uplink.PairingRequest{Platform: "linux", Arch: "amd64", CompanionVersion: "1"}); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("accepted a malformed user code: %v", err)
	}
}

func TestCollectPairing_MapsRFC8628Errors(t *testing.T) {
	for code, want := range map[string]error{
		"authorization_pending": uplink.ErrAuthorizationPending,
		"slow_down":             uplink.ErrSlowDown,
		"expired_token":         uplink.ErrExpiredToken,
		"access_denied":         uplink.ErrAccessDenied,
		"something_new":         uplink.ErrUnexpectedStatus,
	} {
		client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]any{"detail": code, "error_code": code})
		})
		if _, err := client.CollectPairing(context.Background(), "dc_synthetic"); !errors.Is(err, want) {
			t.Errorf("%s: got %v, want %v", code, err, want)
		}
	}
}

func TestCollectPairing_ReturnsTheGrantAndSendsNoCredential(t *testing.T) {
	client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/companion/pairing/token" || r.Header.Get("Authorization") != "" {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["device_code"] != "dc_synthetic" {
			w.WriteHeader(http.StatusTeapot)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"installation_id": "7a1c0de5-0000-4000-8000-000000000001", "device_token": validDeviceToken})
	})
	grant, err := client.CollectPairing(context.Background(), "dc_synthetic")
	if err != nil {
		t.Fatal(err)
	}
	if grant.InstallationID != "7a1c0de5-0000-4000-8000-000000000001" || grant.DeviceToken != validDeviceToken {
		t.Fatalf("grant = %+v", grant)
	}
}

func TestCollectPairing_RejectsAGrantWithoutAUsableToken(t *testing.T) {
	client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"installation_id": "7a1c0de5-0000-4000-8000-000000000001", "device_token": "not-a-token"})
	})
	if _, err := client.CollectPairing(context.Background(), "dc_synthetic"); !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("accepted an unusable token: %v", err)
	}
}

func TestVerificationPageFor_RequiresHTTPSExceptLiteralLoopback(t *testing.T) {
	for _, check := range []struct {
		endpoint, page string
		accepted       bool
	}{
		{"https://backplane.example.com", "https://backplane.example.com/companion/pair", true},
		{"http://127.0.0.1:5173", "http://127.0.0.1:5173/companion/pair", true},
		{"http://[::1]:5173", "http://[::1]:5173/companion/pair", true},
		{"https://backplane.example.com", "http://backplane.example.com/companion/pair", false},
		{"http://localhost:5173", "http://localhost:5173/companion/pair", false},
		{"http://10.0.0.5", "http://10.0.0.5/companion/pair", false},
	} {
		if got := uplink.VerificationPageFor(check.page, check.endpoint, true); got != check.accepted {
			t.Errorf("%s on %s: accepted=%v", check.page, check.endpoint, got)
		}
	}
}

func TestVerificationPageFor_RequiresTheEndpointsOrigin(t *testing.T) {
	const endpoint = "https://bp.example"
	for page, accepted := range map[string]bool{
		"https://bp.example/companion/pair#code=BCDF-GHJK": true,
		"https://BP.example:443/companion/pair":            true,
		"https://evil.example/companion/pair":              false,
		"https://bp.example.evil.io/companion/pair":        false,
		"https://bp.example:8443/companion/pair":           false,
		"https://app.bp.example/companion/pair":            false,
	} {
		if got := uplink.VerificationPageFor(page, endpoint, false); got != accepted {
			t.Errorf("%s: accepted=%v", page, got)
		}
	}
	if uplink.VerificationPageFor("http://127.0.0.1:5173/companion/pair", "http://127.0.0.1:8000", true) {
		t.Error("a loopback page on another port is another origin")
	}
}

func TestStartPairing_RejectsAForeignOriginVerificationPage(t *testing.T) {
	client := anonymousClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(startedBody("https://evil.example/companion/pair"))
	})
	_, err := client.StartPairing(context.Background(), uplink.PairingRequest{Platform: "linux", Arch: "amd64", CompanionVersion: "1"})
	if !errors.Is(err, uplink.ErrForeignVerificationPage) || !errors.Is(err, uplink.ErrInvalidResponse) {
		t.Fatalf("accepted a foreign verification page: %v", err)
	}
}

func TestStartPairing_RefusesPlainHTTPPagesWithoutTheLoopbackOptIn(t *testing.T) {
	// The endpoint is HTTPS (no opt-in), so even a loopback page must be HTTPS.
	if uplink.VerificationPageAllowed("http://127.0.0.1:5173/companion/pair", false) {
		t.Fatal("plain HTTP accepted without AllowLoopbackHTTP")
	}
	if !uplink.VerificationPageAllowed("https://backplane.example.com/companion/pair#code=BCDF-GHJK", false) {
		t.Fatal("HTTPS page refused")
	}
}
