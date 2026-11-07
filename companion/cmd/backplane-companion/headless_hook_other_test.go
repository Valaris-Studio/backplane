// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !unix

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Headless mode is Unix-only, so a config naming the hook socket is refused
// here with the same code as every other headless config.
func TestHeadlessConfig_HookSocketIsRefusedOnThisPlatform(t *testing.T) {
	path := filepath.Join(t.TempDir(), "companion.json")
	config := `{"endpoint":"https://backplane.example.test","token_file":"C:\\token\\device-token",` +
		`"installation_id":"7a1c0de5-0000-4000-8000-0000000000a1","owner_email":"owner@example.test",` +
		`"hook_socket":"C:\\hook\\hook.sock","hook_peer_uid":10000}`
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := loadHeadlessConfig(path)
	if errorCode(err) != "headless_config_invalid" || !strings.Contains(err.Error(), "unsupported_platform") {
		t.Fatalf("got %v, want headless_config_invalid: unsupported_platform", err)
	}
}
