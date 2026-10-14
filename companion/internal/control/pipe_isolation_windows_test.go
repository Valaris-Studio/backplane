// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package control

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
)

func requireIsolatedPipe(t *testing.T, dataDir string) string {
	t.Helper()
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	address := listenerAddress(dataDir)
	if address == "" || address == `\\.\pipe\backplane-companion-`+sid {
		t.Fatalf("data directory %q resolves to an unscoped pipe %q", dataDir, address)
	}
	digest, ok := strings.CutPrefix(address, `\\.\pipe\backplane-companion-`+sid+"-")
	if decoded, err := hex.DecodeString(digest); !ok || err != nil || len(decoded) != 32 || digest != strings.ToLower(digest) {
		t.Fatalf("pipe does not follow the desktop SID/digest contract: %q", address)
	}
	return address
}

func TestWindowsPipesSeparateDataDirectoriesOfTheSameUser(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	if a, b := listenerAddress(first), listenerAddress(second); a == b {
		t.Fatalf("different data directories resolve to the same pipe: %s", a)
	}
	requireIsolatedPipe(t, first)
	requireIsolatedPipe(t, second)
}

func TestWindowsPipeCanonicalSpellingsReachOneEndpoint(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "Companion Data")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	want := requireIsolatedPipe(t, root)
	servePipeMarker(t, root, "canonical home")
	junction := filepath.Join(parent, "Alias")
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", junction, root).CombinedOutput(); err != nil {
		t.Fatalf("create directory junction: %v: %s", err, output)
	}
	for name, spelling := range map[string]string{
		"case":               strings.ToUpper(root),
		"slashes":            strings.ReplaceAll(root, `\`, "/"),
		"trailing_separator": root + `\`,
		"dot":                root + `\.`,
		"verbatim":           `\\?\` + root,
		"junction":           junction,
	} {
		t.Run(name, func(t *testing.T) {
			if got := listenerAddress(spelling); got != want {
				t.Fatalf("%q resolves to %q, want %q", spelling, got, want)
			}
			client := pipeHTTPClient(spelling)
			t.Cleanup(client.CloseIdleConnections)
			reply, err := client.Get("http://companion/v1/status")
			if err != nil {
				t.Fatal(err)
			}
			defer reply.Body.Close()
			if body, err := io.ReadAll(reply.Body); err != nil || string(body) != "canonical home" {
				t.Fatalf("alias reached %q, %v", body, err)
			}
		})
	}
}

func TestWindowsPipeDialNeverFallsBackToTheLegacyEndpoint(t *testing.T) {
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := pipeSecurityDescriptor(sid)
	if err != nil {
		t.Fatal(err)
	}
	// First-instance creation refuses a pre-existing pipe; never dial a legacy
	// endpoint unless this test exclusively owns the harmless sentinel.
	legacy, err := winio.ListenPipe(`\\.\pipe\backplane-companion-`+sid, &winio.PipeConfig{SecurityDescriptor: descriptor})
	if err != nil {
		t.Skipf("cannot exclusively own legacy sentinel; existing endpoint untouched: %v", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "owned legacy sentinel")
	})}
	go server.Serve(legacy)
	t.Cleanup(func() { server.Close() })
	client := pipeHTTPClient(t.TempDir())
	t.Cleanup(client.CloseIdleConnections)
	if reply, err := client.Get("http://companion/v1/status"); err == nil {
		defer reply.Body.Close()
		body, _ := io.ReadAll(reply.Body)
		t.Fatalf("scoped client fell back to the legacy pipe: %q", body)
	}
}

func TestWindowsStartPublishesItsScopedDiscoveryEndpoint(t *testing.T) {
	root := t.TempDir()
	want := requireIsolatedPipe(t, root)
	server := New(Config{DataDir: root, Backend: &fakeBackend{}, WatchInterval: time.Hour, PingInterval: time.Hour})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	data, err := os.ReadFile(DiscoveryPath(root))
	if err != nil {
		t.Fatal(err)
	}
	var discovery struct {
		Version int    `json:"version"`
		Socket  string `json:"socket"`
		PID     int    `json:"pid"`
	}
	if err := json.Unmarshal(data, &discovery); err != nil || discovery.Version != 1 || discovery.Socket != want || discovery.PID != os.Getpid() {
		t.Fatalf("discovery %s, error %v", data, err)
	}
	t.Logf("published control.json: %s", data)
	client := pipeHTTPClient(root)
	t.Cleanup(client.CloseIdleConnections)
	reply, err := client.Get("http://companion/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	reply.Body.Close()
	if reply.StatusCode != http.StatusOK {
		t.Fatalf("discovered server answered %s", reply.Status)
	}
}

func pipeHTTPClient(dataDir string) *http.Client {
	return &http.Client{Timeout: time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return Dial(ctx, dataDir)
		},
	}}
}

func servePipeMarker(t *testing.T, dataDir, marker string) {
	t.Helper()
	requireIsolatedPipe(t, dataDir) // Never touch a live SID-only daemon on an unfixed build.
	listener, err := Listen(dataDir, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, marker)
	})}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
}

func TestWindowsPipeClientsNeverReachAnotherDataDirectory(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	servePipeMarker(t, first, "first")
	client := pipeHTTPClient(second)
	t.Cleanup(client.CloseIdleConnections)
	if reply, err := client.Get("http://companion/v1/status"); err == nil {
		defer reply.Body.Close()
		body, _ := io.ReadAll(reply.Body)
		t.Fatalf("a home without a daemon reached another home's server: %q", body)
	}
	servePipeMarker(t, second, "second")
	for root, want := range map[string]string{first: "first", second: "second"} {
		client := pipeHTTPClient(root)
		t.Cleanup(client.CloseIdleConnections)
		reply, err := client.Get("http://companion/v1/status")
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(reply.Body)
		reply.Body.Close()
		if err != nil || string(body) != want {
			t.Fatalf("home %q reached %q, %v; want %q", root, body, err, want)
		}
	}
}

func TestWindowsPipesRefuseUnresolvedDataDirectories(t *testing.T) {
	for _, root := range []string{"", "relative", filepath.Join(t.TempDir(), "absent")} {
		if got := listenerAddress(root); got != "" {
			t.Fatalf("unresolved directory %q names a pipe: %s", root, got)
		}
		if listener, err := Listen(root, ListenOptions{}); err == nil {
			listener.Close()
			t.Fatalf("listened without a resolved data directory: %q", root)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		conn, err := Dial(ctx, root)
		cancel()
		if err == nil {
			conn.Close()
			t.Fatalf("dialed without a resolved data directory: %q", root)
		}
	}
}
