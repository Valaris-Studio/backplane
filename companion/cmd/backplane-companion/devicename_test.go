// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

const macComputerName = "Ada’s MacBook Pro"

var errScutil = errors.New("scutil: exit status 1")

func fixedSources(scutil string, scutilErr error, hostname string, env map[string]string) computerNameSources {
	return computerNameSources{
		scutil: func() (string, error) {
			if scutilErr != nil {
				return "", scutilErr
			}
			return scutil, nil
		},
		hostname: func() (string, error) { return hostname, nil },
		getenv:   func(key string) string { return env[key] },
	}
}

func TestComputerName_MacUsesTheComputerName(t *testing.T) {
	got := fixedSources(macComputerName+"\n", nil, "Adas-MacBook-Pro.local", nil).read("darwin")
	if got != macComputerName {
		t.Fatalf("got %q, want the ComputerName", got)
	}
}

func TestComputerName_MacFallsBackToTheHostnameWhenScutilFails(t *testing.T) {
	got := fixedSources("", errScutil, "Adas-MacBook-Pro.local", nil).read("darwin")
	if got != "Adas-MacBook-Pro" {
		t.Fatalf("got %q, want the hostname without .local", got)
	}
}

func TestComputerName_MacFallsBackToTheHostnameWhenTheComputerNameIsUnusable(t *testing.T) {
	got := fixedSources(" ‮\x07 ", nil, "studio.local", nil).read("darwin")
	if got != "studio" {
		t.Fatalf("got %q, want the hostname without .local", got)
	}
}

func TestComputerName_LinuxUsesTheHostname(t *testing.T) {
	got := fixedSources("unused", nil, "devbox", nil).read("linux")
	if got != "devbox" {
		t.Fatalf("got %q", got)
	}
}

func TestComputerName_WindowsUsesCOMPUTERNAME(t *testing.T) {
	got := fixedSources("unused", nil, "unused", map[string]string{"COMPUTERNAME": "ADA-PC"}).read("windows")
	if got != "ADA-PC" {
		t.Fatalf("got %q", got)
	}
}

func TestComputerName_StripsControlAndBidiCharacters(t *testing.T) {
	got := fixedSources("Ada‮’s\x07 Mac⁦Book‏\tPro", nil, "", nil).read("darwin")
	if got != "Ada’s MacBook Pro" {
		t.Fatalf("got %q", got)
	}
}

func TestComputerName_UnusableNamesAreEmpty(t *testing.T) {
	cases := map[string]computerNameSources{
		"empty":                 fixedSources("   ", nil, "", nil),
		"only unprintable":      fixedSources("\x00‮‏", nil, "\x1b", nil),
		"longer than 80 runes":  fixedSources(strings.Repeat("é", 81), nil, strings.Repeat("h", 81)+".local", nil),
		"scutil and host fail":  {scutil: func() (string, error) { return "", errScutil }, hostname: func() (string, error) { return "", errScutil }},
		"windows without a var": fixedSources("", nil, "", map[string]string{}),
	}
	for label, sources := range cases {
		goos := "darwin"
		if label == "windows without a var" {
			goos = "windows"
		}
		if got := sources.read(goos); got != "" {
			t.Errorf("%s: got %q, want no usable name", label, got)
		}
	}
}

func TestComputerName_EightyRunesIsKept(t *testing.T) {
	name := strings.Repeat("é", 80)
	if got := fixedSources(name, nil, "", nil).read("darwin"); got != name {
		t.Fatalf("got %q", got)
	}
}

func (h *harness) nameComputer(name string) {
	h.app.computerName = func() string { return name }
}

func (h *harness) pairingStartName(t *testing.T) (any, bool) {
	t.Helper()
	h.server.Lock()
	defer h.server.Unlock()
	name, present := h.server.PairingStarts[0]["name"]
	return name, present
}

func TestConnectBrowser_NeverSendsTheComputerNameUnasked(t *testing.T) {
	h := newHarness(t)
	h.nameComputer(macComputerName)
	if err := h.connectBrowser(t, "granted"); err != nil {
		t.Fatal(err)
	}
	if name, present := h.pairingStartName(t); present {
		t.Fatalf("start sent name %v; only a name the user confirms may leave this computer", name)
	}
	if name := storedInstallation(t, h).Name; name != "testos-testarch-"+uplinktest.PairedInstallationID[:8] {
		t.Fatalf("installation.json names the device %q, want the neutral default", name)
	}
}

func TestConnectBrowser_SendsAnExplicitName(t *testing.T) {
	h := newHarness(t)
	h.nameComputer(macComputerName)
	h.server.Lock()
	h.server.PairingAnswers = []string{"granted"}
	h.server.Unlock()
	delete(h.env, envAPIKey)
	h.app.pairingIntervalUnit = time.Millisecond
	if err := h.run(t, "connect", "--browser", "--endpoint", h.server.URL, "--allow-insecure-loopback", "--name", "work laptop"); err != nil {
		t.Fatal(err)
	}
	if name, _ := h.pairingStartName(t); name != "work laptop" {
		t.Fatalf("start sent name %v", name)
	}
}

func TestRun_PairingThroughTheControlAPINeverSendsTheComputerNameUnasked(t *testing.T) {
	h := pairingHarness(t)
	h.nameComputer(macComputerName)
	daemon := startPairingDaemon(t, h, "granted")
	id := daemon.start(t)
	if status, body := daemon.pollUntilSettled(t, id); status != http.StatusOK {
		t.Fatalf("settled poll: %d %s", status, body)
	}
	if name, present := h.pairingStartName(t); present {
		t.Fatalf("start sent name %v; only a name the user confirms may leave this computer", name)
	}
}

func TestRun_PairingThroughTheControlAPISendsTheConfirmedName(t *testing.T) {
	h := pairingHarness(t)
	h.nameComputer(macComputerName)
	daemon := startPairingDaemon(t, h, "granted")
	status, body := daemon.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+h.server.URL+`","name":"Ada’s Mac"}`)
	if status != http.StatusOK {
		t.Fatalf("pair/start: %d %s", status, body)
	}
	var started struct {
		ID string `json:"pairing_id"`
	}
	json.Unmarshal(body, &started)
	if status, body := daemon.pollUntilSettled(t, started.ID); status != http.StatusOK {
		t.Fatalf("settled poll: %d %s", status, body)
	}
	if name, _ := h.pairingStartName(t); name != "Ada’s Mac" {
		t.Fatalf("start sent name %v", name)
	}
	if name := storedInstallation(t, h).Name; name != "Ada’s Mac" {
		t.Fatalf("installation.json names the device %q", name)
	}
}

func TestConnect_KeepsTheNeutralDefaultWhenTheComputerHasAName(t *testing.T) {
	h := newHarness(t)
	h.nameComputer(macComputerName)
	h.connect(t)
	id := installationID(t, h)
	if name := h.server.Registrations[0]["name"]; name != "testos-testarch-"+id[:8] {
		t.Fatalf("registered name %q, want the neutral default", name)
	}
}

func statusSuggestion(t *testing.T, body []byte) (json.RawMessage, bool) {
	t.Helper()
	var view map[string]json.RawMessage
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("status is not JSON: %v %s", err, body)
	}
	suggestion, present := view["suggested_device_name"]
	return suggestion, present
}

func TestAPIStatus_SuggestsTheComputerNameWhileNotConnected(t *testing.T) {
	h := newHarness(t)
	h.nameComputer(macComputerName)
	_, body := h.api(t).call(t, "GET", "/v1/status", "")
	if suggestion, _ := statusSuggestion(t, body); string(suggestion) != `"`+macComputerName+`"` {
		t.Fatalf("suggested_device_name = %s, want the computer name", suggestion)
	}
}

func TestAPIStatus_NoSuggestionWithoutAUsableComputerName(t *testing.T) {
	h := newHarness(t)
	h.nameComputer("")
	_, body := h.api(t).call(t, "GET", "/v1/status", "")
	if suggestion, present := statusSuggestion(t, body); !present || string(suggestion) != "null" {
		t.Fatalf("suggested_device_name = %s (present %v), want null", suggestion, present)
	}
}

func TestAPIStatus_NoSuggestionOnceConnected(t *testing.T) {
	h := newHarness(t)
	h.nameComputer(macComputerName)
	h.connect(t)
	_, body := h.api(t).call(t, "GET", "/v1/status", "")
	if suggestion, present := statusSuggestion(t, body); !present || string(suggestion) != "null" {
		t.Fatalf("suggested_device_name = %s (present %v), want null once connected", suggestion, present)
	}
}

func TestAPIStatus_ReadsTheComputerNameOnce(t *testing.T) {
	h := newHarness(t)
	var reads atomic.Int32
	h.app.computerName = func() string {
		reads.Add(1)
		return macComputerName
	}
	backend := h.app.controlConfig(store.Layout{Root: h.data}, nil).Backend
	for range 3 {
		if _, err := backend.Status(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if got := reads.Load(); got != 1 {
		t.Fatalf("read the computer name %d times; status must not exec scutil on every build", got)
	}
}

func TestCLIStatus_NeverCarriesTheSuggestion(t *testing.T) {
	h := newHarness(t)
	h.nameComputer(macComputerName)
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(h.stdout.String(), "suggested_device_name") || strings.Contains(h.stdout.String(), macComputerName) {
		t.Fatalf("CLI status keeps its recorded shape: %s", h.stdout)
	}
}

func TestConnect_ReconnectKeepsTheNameOfAnExistingInstallation(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	// As `rename` leaves it once the server accepted the new name.
	installation := storedInstallation(t, h)
	installation.Name = "my renamed box"
	renamed, _ := json.Marshal(installation)
	mustWrite(t, filepath.Join(h.data, "installation.json"), string(renamed))
	(credentials.Keyring{}).Delete(installation.ID)
	h.nameComputer(macComputerName)
	h.connect(t)
	reconnected := storedInstallation(t, h)
	if reconnected.ID != installation.ID || reconnected.Name != "my renamed box" {
		t.Fatalf("reconnect stored %+v, want the renamed installation kept", reconnected)
	}
	if name := h.server.Registrations[len(h.server.Registrations)-1]["name"]; name != "my renamed box" {
		t.Fatalf("reconnect registered %q", name)
	}
}

func storedInstallation(t *testing.T, h *harness) state.Installation {
	t.Helper()
	installation, err := state.Load[state.Installation](filepath.Join(h.data, "installation.json"))
	if err != nil {
		t.Fatal(err)
	}
	return installation
}

func TestAPIStatus_RetriesAFailedComputerNameAtMostOnceAMinute(t *testing.T) {
	h := newHarness(t)
	clock := time.Date(2026, 9, 29, 10, 0, 0, 0, time.UTC)
	h.app.now = func() time.Time { return clock }
	answers := []string{"", macComputerName}
	var reads int
	h.app.computerName = func() string {
		reads++
		return answers[min(reads, len(answers))-1]
	}
	backend := h.app.controlConfig(store.Layout{Root: h.data}, nil).Backend.(*controlBackend)
	suggestion := func() string {
		if name := backend.suggestedDeviceName(); name != nil {
			return *name
		}
		return ""
	}
	if got := suggestion(); got != "" || reads != 1 {
		t.Fatalf("first read: %q after %d reads", got, reads)
	}
	clock = clock.Add(59 * time.Second)
	if got := suggestion(); got != "" || reads != 1 {
		t.Fatalf("a failure was retried within a minute: %q after %d reads", got, reads)
	}
	clock = clock.Add(2 * time.Second)
	if got := suggestion(); got != macComputerName || reads != 2 {
		t.Fatalf("a failure was not retried after a minute: %q after %d reads", got, reads)
	}
	clock = clock.Add(time.Hour)
	if got := suggestion(); got != macComputerName || reads != 2 {
		t.Fatalf("a success was read again: %q after %d reads", got, reads)
	}
}

func TestScutilCommand_RunsWithOnlyAMinimalPath(t *testing.T) {
	t.Setenv("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib")
	command := scutilCommand(context.Background())
	if command.Path != "/usr/sbin/scutil" || strings.Join(command.Args[1:], " ") != "--get ComputerName" {
		t.Fatalf("command = %s %v", command.Path, command.Args)
	}
	if strings.Join(command.Env, "|") != "PATH=/usr/bin:/bin" {
		t.Fatalf("scutil inherits an environment: %v", command.Env)
	}
}
