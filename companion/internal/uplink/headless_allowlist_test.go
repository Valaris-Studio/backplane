// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// A headless client is the device client restricted to the routes capture
// needs: GET /me, GET /policy, POST /status, POST /ingest and /contents/*.
// Anything else fails before a byte is sent, with headless_path_refused.

const headlessInstallation = "7a1c0de5-0000-4000-8000-0000000000c3"

func headlessToken() string { return "bpc_" + strings.Repeat("Up5", 14) + "z" }

// headlessRestricted is how a device client yields its headless copy, as
// WithDeviceToken yields the device client.
type headlessRestricted interface{ Headless() *uplink.Client }

func headlessClients(t *testing.T) (*uplinktest.Server, *uplink.Client, *uplink.Client) {
	t.Helper()
	server := uplinktest.New(t)
	server.IssueDeviceToken(headlessToken(), headlessInstallation, "owner@example.test")
	client, err := uplink.New(uplink.Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	device, err := client.WithDeviceToken(headlessToken())
	if err != nil {
		t.Fatal(err)
	}
	restricted, ok := any(device).(headlessRestricted)
	if !ok {
		t.Fatal("uplink.Client has no Headless(): the headless path allowlist is absent")
	}
	return server, device, restricted.Headless()
}

// hasCode reports whether err or anything it wraps is the sentinel named
// code (sentinels here are errors.New(code)).
func hasCode(err error, code string) bool {
	if err == nil {
		return false
	}
	if err.Error() == code {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, inner := range joined.Unwrap() {
			if hasCode(inner, code) {
				return true
			}
		}
		return false
	}
	return hasCode(errors.Unwrap(err), code)
}

func TestHeadlessClient_RefusesEveryOtherRouteBeforeSending(t *testing.T) {
	server, _, headless := headlessClients(t)
	ctx := context.Background()
	refused := map[string]func() error{
		"self-revoke":        func() error { return headless.RevokeInstallation(ctx) },
		"auto-match mapping": func() error { _, err := headless.ResolveMapping(ctx, "github.com/acme/app"); return err },
		"create mapping": func() error {
			_, err := headless.CreateMapping(ctx, uplink.MappingRequest{WorkspaceID: "w", BoardID: "b", RepoURL: "github.com/acme/app", ContentLevel: "standard"})
			return err
		},
		"update mapping":   func() error { _, err := headless.UpdateMapping(ctx, "m1", uplink.MappingUpdate{}); return err },
		"delete mapping":   func() error { return headless.DeleteMapping(ctx, "m1") },
		"list mappings":    func() error { _, err := headless.Mappings(ctx); return err },
		"settings":         func() error { _, err := headless.UpdateSettings(ctx, uplink.SettingsUpdate{}); return err },
		"boards":           func() error { _, err := headless.Boards(ctx); return err },
		"sessions":         func() error { _, err := headless.Sessions(ctx, uplink.SessionQuery{}); return err },
		"session":          func() error { _, err := headless.Session(ctx, "s1"); return err },
		"session usage":    func() error { _, err := headless.SessionUsage(ctx, "s1"); return err },
		"rename":           func() error { return headless.RenameInstallation(ctx, "desk") },
		"mint agent key":   func() error { _, err := headless.CreateAgentKey(ctx); return err },
		"read agent key":   func() error { _, err := headless.AgentKey(ctx); return err },
		"delete agent key": func() error { return headless.DeleteAgentKey(ctx) },
		"enroll": func() error {
			_, err := headless.RegisterInstallation(ctx, uplinktest.APIKey, uplink.InstallationRequest{InstallationID: headlessInstallation})
			return err
		},
		"rotate": func() error {
			_, err := headless.RotateInstallation(ctx, uplinktest.APIKey, headlessInstallation)
			return err
		},
		"start pairing":   func() error { _, err := headless.StartPairing(ctx, uplink.PairingRequest{}); return err },
		"collect pairing": func() error { _, err := headless.CollectPairing(ctx, "dc_synthetic"); return err },
	}
	for name, call := range refused {
		err := call()
		if !hasCode(err, "headless_path_refused") {
			t.Errorf("%s: %v, want headless_path_refused", name, err)
		}
		if err != nil && strings.Contains(err.Error(), headlessToken()) {
			t.Errorf("%s: the refusal carries the token", name)
		}
	}
	if requests := server.Requests(); len(requests) != 0 {
		var sent []string
		for _, request := range requests {
			sent = append(sent, request.Method+" "+request.Path)
		}
		t.Fatalf("refused routes were sent: %v", sent)
	}
}

func TestHeadlessClient_SendsTheCaptureRoutes(t *testing.T) {
	server, device, headless := headlessClients(t)
	ctx := context.Background()
	if me, err := headless.Me(ctx); err != nil || me.Installation.ID != headlessInstallation {
		t.Fatalf("GET /me: %+v %v", me, err)
	}
	if fetched, err := headless.Policy(ctx); err != nil || fetched.Installation.ID != headlessInstallation {
		t.Fatalf("GET /policy: %+v %v", fetched.Installation, err)
	}
	if _, err := headless.ReportStatus(ctx, uplink.StatusReport{CompanionVersion: "dev", Agents: []uplink.AgentStatus{}}); err != nil {
		t.Fatalf("POST /status: %v", err)
	}
	record := json.RawMessage(`{"capture_id":"0123456789abcdef0123456789abcdef"}`)
	if ack, err := headless.Ingest(ctx, []json.RawMessage{record}); err != nil || len(ack.Acknowledged) != 1 {
		t.Fatalf("POST /ingest: %+v %v", ack, err)
	}
	if _, err := headless.ContentUpload(ctx, "content-1"); hasCode(err, "headless_path_refused") {
		t.Fatalf("GET /contents/{id} must be allowed: %v", err)
	}
	sent := map[string]bool{}
	for _, request := range server.Requests() {
		sent[request.Method+" "+request.Path] = true
	}
	for _, want := range []string{"GET /api/companion/me", "GET /api/companion/policy", "POST /api/companion/status", "POST /api/companion/ingest", "GET /api/companion/contents/content-1"} {
		if !sent[want] {
			t.Errorf("%s was not sent: %v", want, sent)
		}
	}
	// The desktop client keeps its whole surface.
	if _, err := device.Boards(ctx); hasCode(err, "headless_path_refused") {
		t.Fatalf("the unrestricted device client was restricted: %v", err)
	}
}
