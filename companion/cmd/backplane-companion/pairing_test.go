// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

func (h *harness) connectBrowser(t *testing.T, answers ...string) error {
	t.Helper()
	h.server.Lock()
	h.server.PairingAnswers = answers
	h.server.Unlock()
	// Browser pairing never asks for an API key.
	delete(h.env, envAPIKey)
	h.app.pairingIntervalUnit = time.Millisecond
	return h.run(t, "connect", "--browser", "--endpoint", h.server.URL, "--allow-insecure-loopback")
}

func jsonDocuments(t *testing.T, output string) []map[string]any {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(output))
	var documents []map[string]any
	for {
		var document map[string]any
		if err := decoder.Decode(&document); errors.Is(err, io.EOF) {
			return documents
		} else if err != nil {
			t.Fatalf("stdout is not a JSON stream: %v\n%s", err, output)
		}
		documents = append(documents, document)
	}
}

func TestConnectBrowser_PrintsTheCodeThenStoresTheGrantedInstallation(t *testing.T) {
	h := newHarness(t)
	if err := h.connectBrowser(t, "authorization_pending", "granted"); err != nil {
		t.Fatal(err)
	}
	documents := jsonDocuments(t, h.stdout.String())
	if len(documents) != 2 {
		t.Fatalf("want the code, then the result; got %v", documents)
	}
	code := documents[0]
	if code["user_code"] != "BCDF-GHJK" || code["verification_uri_complete"] != h.server.URL+"/companion/pair#code=BCDF-GHJK" || code["expires_at"] == nil {
		t.Fatalf("code document = %v", code)
	}
	if strings.Contains(h.stdout.String(), "dc_synthetic") || strings.Contains(h.stdout.String(), uplinktest.DeviceToken) {
		t.Fatal("the device code or token reached stdout")
	}
	if result := documents[1]; result["connected"] != true || result["installation_id"] != uplinktest.PairedInstallationID {
		t.Fatalf("result document = %v", result)
	}
	if token, err := h.app.keyring.Load(uplinktest.PairedInstallationID); err != nil || token != uplinktest.DeviceToken {
		t.Fatalf("keyring holds %q, %v", token, err)
	}
	if id := installationID(t, h); id != uplinktest.PairedInstallationID {
		t.Fatalf("installation.json names %q", id)
	}
	h.server.Lock()
	start := h.server.PairingStarts[0]
	h.server.Unlock()
	if start["platform"] != "testos" || start["arch"] != "testarch" || start["name"] != nil {
		t.Fatalf("start body = %v (an unnamed device lets the server pick the neutral name)", start)
	}
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
}

func TestConnectBrowser_DeniedStoresNothing(t *testing.T) {
	h := newHarness(t)
	err := h.connectBrowser(t, "authorization_pending", "access_denied")
	if errorCode(err) != "pairing_denied" {
		t.Fatalf("connect --browser after deny: %v", err)
	}
	if _, err := os.Stat(filepath.Join(h.data, "installation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a denied pairing persisted an installation")
	}
	if _, err := h.app.keyring.Load(uplinktest.PairedInstallationID); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("a denied pairing left a keyring entry: %v", err)
	}
}

func TestConnectBrowser_ExpiredCodeIsReported(t *testing.T) {
	h := newHarness(t)
	if err := h.connectBrowser(t, "expired_token"); errorCode(err) != "pairing_expired" {
		t.Fatalf("connect --browser after expiry: %v", err)
	}
}

func TestConnectBrowser_RefusesWhenAlreadyConnected(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	if err := h.connectBrowser(t, "granted"); !errors.Is(err, errAlreadyConnected) {
		t.Fatalf("connect --browser while connected: %v", err)
	}
	h.server.Lock()
	defer h.server.Unlock()
	if len(h.server.PairingStarts) != 0 {
		t.Fatal("started a pairing while already connected")
	}
}

// blockInstallationFile makes installation.json unwritable after the token is
// saved, the last step a connection can fail at.
func blockInstallationFile(t *testing.T, h *harness) {
	t.Helper()
	mustMkdir(t, filepath.Join(h.data, "installation.json", "blocked"))
}

func TestConnectBrowser_RollsBackWhenTheInstallationCannotBeStored(t *testing.T) {
	h := newHarness(t)
	blockInstallationFile(t, h)
	if err := h.connectBrowser(t, "granted"); err == nil {
		t.Fatal("connect --browser succeeded without storing the installation")
	}
	if _, err := h.app.keyring.Load(uplinktest.PairedInstallationID); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("an orphan keyring entry survived the failed connect: %v", err)
	}
	h.server.Lock()
	defer h.server.Unlock()
	if !h.server.Revoked[uplinktest.PairedInstallationID] {
		t.Fatal("the paired installation was left active on the server")
	}
}

func TestConnect_RollsBackTheTokenWhenTheInstallationCannotBeStored(t *testing.T) {
	h := newHarness(t)
	blockInstallationFile(t, h)
	if err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback"); err == nil {
		t.Fatal("connect succeeded without storing the installation")
	}
	h.server.Lock()
	enrolled := h.server.Registrations[0]["installation_id"]
	revoked := h.server.Revoked[enrolled]
	h.server.Unlock()
	if _, err := h.app.keyring.Load(enrolled); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("an orphan keyring entry survived the failed connect: %v", err)
	}
	if !revoked {
		t.Fatal("the enrolled installation was left active on the server")
	}
}

func TestConnectBrowser_RequiresAnEndpoint(t *testing.T) {
	h := newHarness(t)
	h.app.pairingIntervalUnit = time.Millisecond
	if err := h.run(t, "connect", "--browser"); !errors.Is(err, errUsage) {
		t.Fatalf("connect --browser without --endpoint: %v", err)
	}
}
