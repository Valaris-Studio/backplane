// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// Qualified natively in DK-W1; compiled everywhere through GOOS=windows vet.
func TestEnsurePrivateDir_WindowsAcceptsTheProfileDefault(t *testing.T) {
	if err := EnsurePrivateDir(filepath.Join(t.TempDir(), "Companion")); err != nil {
		t.Fatal(err)
	}
}

func TestEnsurePrivateDir_WindowsRejectsAnInheritedEveryoneGrant(t *testing.T) {
	parent := t.TempDir()
	everyone, err := windows.StringToSid("S-1-1-0")
	if err != nil {
		t.Fatal(err)
	}
	grant := []windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_READ,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_WELL_KNOWN_GROUP,
			TrusteeValue: windows.TrusteeValueFromSID(everyone),
		},
	}}
	current, err := windows.GetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	existing, _, err := current.DACL()
	if err != nil {
		t.Fatal(err)
	}
	widened, err := windows.ACLFromEntries(grant, existing)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, widened, nil); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(parent, "Companion")
	if err := EnsurePrivateDir(dir); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("directory readable by Everyone accepted: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("the check should run on the created directory: %v", err)
	}
}

func TestEnsurePrivateDir_WindowsReadsTheOwner(t *testing.T) {
	security, err := readDirSecurity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if security.owner != user.User.Sid.String() && security.owner != sidAdministrators {
		t.Fatalf("temp dir owner %s", security.owner)
	}
}
