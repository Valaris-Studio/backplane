// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package profile stores per-instance runner configuration under
// <root>/profiles/<name>/{credentials, runner.yaml, mcp-config.json}, so two
// runner instances on one machine stop stomping the three fixed-path files
// that used to live directly under ~/.config/backplane/.
package profile

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

var (
	// ErrProfileNotFound is returned by Load/LoadForRun/ResolveProfileConfigPath
	// when no profile with the requested name exists.
	ErrProfileNotFound = errors.New("profile not found")

	// ErrProfileExists is returned by Save when the profile directory is
	// already taken; SaveOverwrite is the explicit-replacement path.
	ErrProfileExists = errors.New("profile already exists")

	// ErrInvalidName rejects names that cannot safely become directory names:
	// empty, containing a path separator, "..", or starting with a dot.
	ErrInvalidName = errors.New("invalid profile name")

	// ErrConflictingFlags is returned by ResolveRunConfigPath when both
	// -config and -profile were given — they name the same file two ways.
	ErrConflictingFlags = errors.New("-config and -profile are mutually exclusive")
)

const (
	profilesDirName     = "profiles"
	defaultProfileName  = "default"
	credentialsFilename = "credentials"
	runnerYAMLFilename  = "runner.yaml"
	mcpConfigFilename   = "mcp-config.json"

	// Each name matches the env var it stands in for, same convention as the
	// legacy root-level credentials file in cmd/backplane-runner.
	envAPIKey    = "VALARIS_API_KEY"
	envAPIURL    = "VALARIS_API_URL"
	envWorkspace = "VALARIS_WORKSPACE"
)

// credentialsFileHeader documents the file in the file, for the operator who
// finds it months later with no repo in front of them.
const credentialsFileHeader = "# Backplane runner profile credentials — written by `backplane-runner`.\n" +
	"# Simple KEY=value lines; # starts a comment. Owner-readable only (0600)\n" +
	"# because of the key. Deleting the profile directory removes it safely.\n"

// Credentials is the triple the per-profile credentials file stores, in the
// same KEY=value format (VALARIS_API_KEY / VALARIS_API_URL /
// VALARIS_WORKSPACE) as the legacy root-level credentials file.
type Credentials struct {
	APIKey    string
	APIURL    string
	Workspace string
}

// Profile is one stored runner identity: its name, its directory under
// <root>/profiles/, and the credentials loaded from its credentials file.
type Profile struct {
	Name        string
	Dir         string
	Credentials Credentials
}

// Store reads and writes profiles under an explicit root config dir.
type Store struct {
	root string
}

// NewStore returns a Store rooted at the given backplane config dir.
func NewStore(root string) *Store { return &Store{root: root} }

// DefaultRoot resolves $XDG_CONFIG_HOME/backplane, else ~/.config/backplane —
// the same convention as credentialsFilePath in cmd/backplane-runner.
func DefaultRoot() string {
	if configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configHome != "" {
		return filepath.Join(configHome, "backplane")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "backplane")
}

func validateName(name string) error {
	if name == "" || strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\`) {
		return fmt.Errorf("%w: %q", ErrInvalidName, name)
	}
	return nil
}

func (s *Store) profilesDir() string { return filepath.Join(s.root, profilesDirName) }

// profileNames lists the directory names under profiles/, skipping stray
// files and dot-directories a file manager may have dropped there. ReadDir
// returns entries sorted by name, so the result is already ordered.
func (s *Store) profileNames() ([]string, error) {
	entries, err := os.ReadDir(s.profilesDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() && validateName(entry.Name()) == nil {
			names = append(names, entry.Name())
		}
	}
	return names, nil
}

// migrateLegacy copies the root-level files of the pre-profile layout into
// profiles/default/, only when no profile exists yet. It COPIES instead of
// moving: older runner binaries and operator one-liners still read the legacy
// paths, and migration must leave them byte-identical.
func (s *Store) migrateLegacy() error {
	names, err := s.profileNames()
	if err != nil || len(names) > 0 {
		return err
	}

	legacyFiles := []struct {
		name string
		perm os.FileMode
	}{
		{credentialsFilename, 0o600},
		{runnerYAMLFilename, 0o644},
		{mcpConfigFilename, 0o600},
	}
	defaultDir := filepath.Join(s.profilesDir(), defaultProfileName)
	created := false
	for _, file := range legacyFiles {
		data, err := os.ReadFile(filepath.Join(s.root, file.name))
		if err != nil {
			// Partial legacy state is normal (e.g. credentials without an
			// mcp-config); copy only what is actually there.
			continue
		}
		if !created {
			if err := os.MkdirAll(defaultDir, 0o700); err != nil {
				return err
			}
			created = true
		}
		if err := os.WriteFile(filepath.Join(defaultDir, file.name), data, file.perm); err != nil {
			return err
		}
	}
	return nil
}

// parseCredentials mirrors readCredentialsFile in cmd/backplane-runner: a
// missing or malformed file degrades to zero values, never an error.
func parseCredentials(path string) Credentials {
	var c Credentials
	data, err := os.ReadFile(path)
	if err != nil {
		return c
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
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(name) {
		case envAPIKey:
			c.APIKey = value
		case envAPIURL:
			c.APIURL = value
		case envWorkspace:
			c.Workspace = value
		}
	}
	return c
}

func (s *Store) readProfile(name string) (Profile, error) {
	dir := filepath.Join(s.profilesDir(), name)
	if _, err := os.Stat(dir); err != nil {
		if os.IsNotExist(err) {
			return Profile{}, fmt.Errorf("%w: %q", ErrProfileNotFound, name)
		}
		return Profile{}, err
	}
	return Profile{
		Name:        name,
		Dir:         dir,
		Credentials: parseCredentials(filepath.Join(dir, credentialsFilename)),
	}, nil
}

// List returns all profiles sorted by name, migrating legacy root-level files
// into profiles/default/ first when profiles/ is empty or absent.
func (s *Store) List() ([]Profile, error) {
	if err := s.migrateLegacy(); err != nil {
		return nil, err
	}
	return s.ListExisting()
}

// ListExisting enumerates saved profiles without migrating or creating files.
func (s *Store) ListExisting() ([]Profile, error) {
	names, err := s.profileNames()
	if err != nil {
		return nil, err
	}
	profiles := make([]Profile, 0, len(names))
	for _, name := range names {
		p, err := s.readProfile(name)
		if err != nil {
			return nil, err
		}
		profiles = append(profiles, p)
	}
	return profiles, nil
}

// Load returns the named profile, running the same legacy migration as List.
func (s *Store) Load(name string) (Profile, error) {
	if err := validateName(name); err != nil {
		return Profile{}, err
	}
	if err := s.migrateLegacy(); err != nil {
		return Profile{}, err
	}
	return s.readProfile(name)
}

func renderCredentials(c Credentials) []byte {
	var body strings.Builder
	body.WriteString(credentialsFileHeader)
	for _, field := range []struct{ name, value string }{
		{envAPIKey, c.APIKey},
		{envAPIURL, c.APIURL},
		{envWorkspace, c.Workspace},
	} {
		// An empty field is omitted rather than written blank — same rule as
		// the legacy credentials file, so "unset" stays distinguishable from
		// "remembered as nothing".
		if value := strings.TrimSpace(field.value); value != "" {
			body.WriteString(field.name + "=" + value + "\n")
		}
	}
	return []byte(body.String())
}

// writeSecretFile writes owner-only content, re-chmodding because WriteFile
// leaves an EXISTING file's mode untouched — overwriting a world-readable
// file must not silently keep it world-readable.
func writeSecretFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func (s *Store) writeProfile(name string, c Credentials, runnerYAML, mcpConfig []byte) error {
	dir := filepath.Join(s.profilesDir(), name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// runner.yaml carries the ${VALARIS_API_KEY} placeholder convention, not
	// the key itself, so it does not need the owner-only treatment.
	if err := os.WriteFile(filepath.Join(dir, runnerYAMLFilename), runnerYAML, 0o644); err != nil {
		return err
	}
	if err := writeSecretFile(filepath.Join(dir, credentialsFilename), renderCredentials(c)); err != nil {
		return err
	}
	return writeSecretFile(filepath.Join(dir, mcpConfigFilename), mcpConfig)
}

// Save creates profiles/<name>/ with all three files. The credentials file
// and mcp-config.json are owner-only (0600) — per-profile files DO store the
// real key; that is their job.
func (s *Store) Save(name string, c Credentials, runnerYAML, mcpConfig []byte) error {
	if err := validateName(name); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(s.profilesDir(), name)); err == nil {
		return fmt.Errorf("%w: %q", ErrProfileExists, name)
	} else if !os.IsNotExist(err) {
		return err
	}
	return s.writeProfile(name, c, runnerYAML, mcpConfig)
}

// SaveOverwrite is Save without the clobber guard, re-securing 0600 even when
// a prior file had loose permissions.
func (s *Store) SaveOverwrite(name string, c Credentials, runnerYAML, mcpConfig []byte) error {
	if err := validateName(name); err != nil {
		return err
	}
	return s.writeProfile(name, c, runnerYAML, mcpConfig)
}

// Delete removes the profile directory including the stored key. Deleting a
// missing profile is not an error.
func (s *Store) Delete(name string) error {
	if err := validateName(name); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(s.profilesDir(), name))
}

// Match finds the profile whose APIKey AND APIURL AND Workspace all equal c.
func (s *Store) Match(c Credentials) (Profile, bool, error) {
	profiles, err := s.List()
	if err != nil {
		return Profile{}, false, err
	}
	for _, p := range profiles {
		if p.Credentials == c {
			return p, true, nil
		}
	}
	return Profile{}, false, nil
}

// SuggestName proposes "<workspace>@<first DNS label of the API URL host>",
// suffixing -2, -3, … while taken. An unparseable URL yields just workspace.
func (s *Store) SuggestName(c Credentials) string {
	base := c.Workspace
	if label := firstHostLabel(c.APIURL); label != "" {
		base = c.Workspace + "@" + label
	}
	name := base
	for n := 2; s.nameTaken(name); n++ {
		name = fmt.Sprintf("%s-%d", base, n)
	}
	return name
}

func (s *Store) nameTaken(name string) bool {
	_, err := os.Stat(filepath.Join(s.profilesDir(), name))
	return err == nil
}

// firstHostLabel extracts "intern" from "https://intern.example.com" —
// Hostname() already strips any port.
func firstHostLabel(apiURL string) string {
	u, err := url.Parse(apiURL)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	if host == "" {
		return ""
	}
	return strings.Split(host, ".")[0]
}

// ConfigPath, CredentialsPath and MCPConfigPath are pure string joins to the
// three per-profile files — no IO, no existence check.
func (s *Store) ConfigPath(name string) string {
	return filepath.Join(s.profilesDir(), name, runnerYAMLFilename)
}
func (s *Store) CredentialsPath(name string) string {
	return filepath.Join(s.profilesDir(), name, credentialsFilename)
}
func (s *Store) MCPConfigPath(name string) string {
	return filepath.Join(s.profilesDir(), name, mcpConfigFilename)
}

// ResolveProfileConfigPath is the -profile flag's config resolver: the named
// profile's runner.yaml, or ErrProfileNotFound.
func ResolveProfileConfigPath(root, name string) (string, error) {
	s := NewStore(root)
	if _, err := s.Load(name); err != nil {
		return "", err
	}
	return s.ConfigPath(name), nil
}

// ResolveRunConfigPath arbitrates the -config and -profile flags: both set is
// ErrConflictingFlags, -profile resolves through the store, -config passes
// through verbatim, neither yields "" (caller falls back to discovery).
func ResolveRunConfigPath(root, configFlag, profileFlag string) (string, error) {
	switch {
	case configFlag != "" && profileFlag != "":
		return "", ErrConflictingFlags
	case profileFlag != "":
		return ResolveProfileConfigPath(root, profileFlag)
	default:
		return configFlag, nil
	}
}

// LoadForRun loads the named profile for a run. An explicit profile beats the
// VALARIS_* environment: when an env var is set to a DIFFERENT value than the
// profile stores, the profile's value wins and a warning naming that env var
// is returned so the caller can tell the operator what was ignored.
func LoadForRun(root, name string) (Profile, []string, error) {
	p, err := NewStore(root).Load(name)
	if err != nil {
		return Profile{}, nil, err
	}
	var warnings []string
	for _, field := range []struct{ envVar, profileValue string }{
		{envAPIKey, p.Credentials.APIKey},
		{envAPIURL, p.Credentials.APIURL},
		{envWorkspace, p.Credentials.Workspace},
	} {
		// An empty profile field is a gap the environment may legitimately
		// fill (main.go's re-assert skips empty fields) — only a stored,
		// differing value is a conflict worth warning about.
		if env := os.Getenv(field.envVar); field.profileValue != "" && env != "" && env != field.profileValue {
			warnings = append(warnings, fmt.Sprintf(
				"ignoring %s from the environment: profile %q pins a different value", field.envVar, name))
		}
	}
	return p, warnings, nil
}
