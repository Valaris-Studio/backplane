// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func answerMeAs(deviceName *atomic.Value) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"email": "jane@example.com", "display_name": "Jane"}, "installation": map[string]any{"id": "i", "name": deviceName.Load()}, "web_origin": "https://app.example"})
	}
}

func (c *apiClient) deviceName(t *testing.T) (string, bool) {
	t.Helper()
	_, body := c.call(t, "GET", "/v1/status", "")
	var view struct {
		Account map[string]json.RawMessage `json:"account"`
	}
	if err := json.Unmarshal(body, &view); err != nil || view.Account == nil {
		return "", false
	}
	var name string
	raw, present := view.Account["device_name"]
	if !present || json.Unmarshal(raw, &name) != nil {
		t.Fatalf("account without a device_name: %s", body)
	}
	return name, true
}

func (c *apiClient) eventuallyDeviceName(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		if name, ok := c.deviceName(t); ok && name == want {
			return
		} else if ok {
			got = name
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("device_name %q never became %q", got, want)
}

func TestAPIStatus_AccountCarriesTheDeviceName(t *testing.T) {
	h := newHarness(t)
	endpoint, _ := meServer(t, h, answerMe)
	h.connectTo(t, endpoint)
	h.api(t).eventuallyDeviceName(t, "laptop")
	if err := h.run(t, "status"); err != nil || strings.Contains(h.stdout.String(), `"device_name"`) {
		t.Fatalf("CLI status keeps its recorded shape: %s", h.stdout)
	}
}

func backendDeviceName(t *testing.T, backend *controlBackend) string {
	t.Helper()
	snapshot, err := backend.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(snapshot.Status)
	var view struct {
		Account *struct {
			DeviceName string `json:"device_name"`
		} `json:"account"`
	}
	json.Unmarshal(encoded, &view)
	if view.Account == nil {
		return ""
	}
	return view.Account.DeviceName
}

func eventuallyBackendDeviceName(t *testing.T, backend *controlBackend, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	got := ""
	for time.Now().Before(deadline) {
		if got = backendDeviceName(t, backend); got == want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("device_name %q never became %q", got, want)
}

func TestAPIStatus_DeviceNameFollowsARenameAfterThePolicyRefresh(t *testing.T) {
	h := newHarness(t)
	var deviceName atomic.Value
	deviceName.Store("laptop")
	endpoint, _ := meServer(t, h, answerMeAs(&deviceName))
	h.connectTo(t, endpoint)
	backend := h.app.controlConfig(store.Layout{Root: h.data}, nil).Backend.(*controlBackend)
	eventuallyBackendDeviceName(t, backend, "laptop")
	deviceName.Store("desk")
	if err := backend.RefreshPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	eventuallyBackendDeviceName(t, backend, "desk")
}

func TestAPIStatus_NoDeviceNameWhenNotConnected(t *testing.T) {
	h := newHarness(t)
	if _, present := h.api(t).deviceName(t); present {
		t.Fatal("no account, so no device_name, while not connected")
	}
}

func TestRefreshPolicy_NeverWaitsForTheAccount(t *testing.T) {
	h := newHarness(t)
	release := make(chan struct{})
	endpoint, calls := meServer(t, h, func(w http.ResponseWriter) {
		<-release
		answerMe(w)
	})
	defer close(release)
	h.connectTo(t, endpoint)
	backend := h.app.controlConfig(store.Layout{Root: h.data}, nil).Backend.(*controlBackend)
	started := time.Now()
	if err := backend.RefreshPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("a policy refresh waited %v for /me", elapsed)
	}
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() == 0 {
		t.Fatal("the policy refresh must still refresh the account, in the background")
	}
}

func TestRefreshPolicy_AccountFetchOutlivesTheRequestButIsTimeBounded(t *testing.T) {
	h := newHarness(t)
	upstream, _ := url.Parse(h.server.URL)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	fetchLasted := make(chan time.Duration, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/companion/me" {
			proxy.ServeHTTP(w, r)
			return
		}
		arrived := time.Now()
		<-r.Context().Done()
		fetchLasted <- time.Since(arrived)
	}))
	t.Cleanup(server.Close)
	h.connectTo(t, server.URL)
	backend := h.app.controlConfig(store.Layout{Root: h.data}, nil).Backend.(*controlBackend)
	requestCtx, endRequest := context.WithCancel(context.Background())
	if err := backend.RefreshPolicy(requestCtx); err != nil {
		t.Fatal(err)
	}
	endRequest()
	select {
	case lasted := <-fetchLasted:
		if lasted < accountRefreshTimeout-time.Second {
			t.Fatalf("the fetch was cut after %v, tied to the finished request", lasted)
		}
		if lasted > accountRefreshTimeout+2*time.Second {
			t.Fatalf("the fetch ran %v, past its bound", lasted)
		}
	case <-time.After(accountRefreshTimeout + 5*time.Second):
		t.Fatal("the background account fetch is not time-bounded")
	}
}
