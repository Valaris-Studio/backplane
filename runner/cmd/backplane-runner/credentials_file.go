// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The runner keeps the agent key OUT of runner.yaml on purpose: a config file
// is something operators copy, paste into issues and commit by accident, so it
// carries the ${VALARIS_API_KEY} placeholder instead. The real key lives here,
// in a single-purpose owner-only file the wizard writes and resolveCredentials
// reads.
//
// The file is the "remembered session": host and workspace ride along with the
// key even though they are not secrets. Splitting them across two files meant a
// wizard run that did not also write a runner.yaml — doctor, discovery, or any
// operator who left the save toggle off — remembered the key and then asked for
// the host again on the next launch.

const (
	// credentialsFilename sits beside runner.yaml in the same config home, so
	// "where is my Backplane config?" has one answer.
	credentialsFilename = "credentials"

	// Each name matches the env var it stands in for, so an operator who reads
	// the file knows exactly which `export` reproduces it.
	credentialsAPIKeyName    = "VALARIS_API_KEY"
	credentialsAPIURLName    = "VALARIS_API_URL"
	credentialsWorkspaceName = "VALARIS_WORKSPACE"
)

// credentialsFileHeader documents the file in the file, for the operator who
// finds it months later with no repo in front of them.
const credentialsFileHeader = "# Backplane runner credentials — written by `backplane-runner` interactive setup.\n" +
	"# The last host, agent key and workspace that authenticated successfully.\n" +
	"# Owner-readable only (0600) because of the key; the host and workspace are\n" +
	"# not secrets and are stored here only to keep one file per remembered session.\n" +
	"# Simple KEY=value lines; # starts a comment.\n" +
	"# Read at startup with lower precedence than the environment, and higher\n" +
	"# than runner.yaml — export any of these to override it for one run.\n" +
	"# Deleting this file is safe: setup will offer to write it again.\n"

// RememberedSession is what one successful wizard run leaves behind for the
// next launch to prefill.
type RememberedSession struct {
	APIKey    string
	APIURL    string
	Workspace string
}

// credentialsFilePath is where the agent key is kept, following the same
// XDG-then-home convention as defaultConfigPath so both land in one directory.
func credentialsFilePath(homeDir string) string {
	if configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configHome != "" {
		return filepath.Join(configHome, "backplane", credentialsFilename)
	}
	if homeDir == "" {
		return ""
	}
	return filepath.Join(homeDir, ".config", "backplane", credentialsFilename)
}

// saveCredentialsFile writes the remembered session to path with owner-only
// permissions, creating parent directories. Unlike SaveConfig it always
// replaces: the operator just typed these into a prompt whose entire purpose is
// to change them.
func saveCredentialsFile(path string, session RememberedSession) error {
	if path == "" {
		return fmt.Errorf("no credentials path: cannot locate a config home")
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
	}

	var body strings.Builder
	body.WriteString(credentialsFileHeader)
	for _, field := range []struct{ name, value string }{
		{credentialsAPIKeyName, session.APIKey},
		{credentialsAPIURLName, session.APIURL},
		{credentialsWorkspaceName, session.Workspace},
	} {
		// An empty field is omitted rather than written blank: a `NAME=` line
		// would read as "remembered, and it is nothing", masking a value a
		// runner.yaml further down the precedence chain could still supply.
		if value := strings.TrimSpace(field.value); value != "" {
			body.WriteString(field.name + "=" + value + "\n")
		}
	}
	if err := os.WriteFile(path, []byte(body.String()), 0o600); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	// WriteFile leaves an EXISTING file's mode untouched, so replacing a
	// world-readable credentials file would silently keep it world-readable.
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("securing %s: %w", path, err)
	}
	return nil
}

// readCredentialsFile parses the KEY=value lines into the session they
// describe. A missing, unreadable or malformed file yields a zero value — a
// broken credentials file must degrade to "nothing remembered here", never
// block a startup that the environment could still satisfy.
func readCredentialsFile(path string) RememberedSession {
	var session RememberedSession
	if path == "" {
		return session
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return session
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		// Quotes are what a shell-trained operator adds by hand; strip them so
		// a value does not arrive wrapped in a character the header never used.
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(name) {
		case credentialsAPIKeyName:
			session.APIKey = value
		case credentialsAPIURLName:
			session.APIURL = value
		case credentialsWorkspaceName:
			session.Workspace = value
		}
	}
	return session
}
