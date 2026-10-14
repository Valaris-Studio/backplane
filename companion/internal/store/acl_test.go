// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package store

import (
	"errors"
	"testing"
)

const userSID = "S-1-5-21-1-2-3-1001"

// The ACL %LOCALAPPDATA% children inherit on a default Windows profile.
var defaultProfileDACL = []aclEntry{
	{SID: sidSystem, Inherited: true},
	{SID: sidAdministrators, Inherited: true},
	{SID: userSID, Inherited: true},
}

func TestStore_WindowsDefaultProfileACLAccepted(t *testing.T) {
	if err := checkPrivateDACL(defaultProfileDACL, true, userSID); err != nil {
		t.Fatal(err)
	}
	withCreatorOwner := append(defaultProfileDACL[:len(defaultProfileDACL):len(defaultProfileDACL)], aclEntry{SID: sidCreatorOwner, Inherited: true})
	if err := checkPrivateDACL(withCreatorOwner, true, userSID); err != nil {
		t.Fatal(err)
	}
}

func TestStore_WindowsInheritedEveryoneACLRejected(t *testing.T) {
	dacl := append(defaultProfileDACL[:len(defaultProfileDACL):len(defaultProfileDACL)], aclEntry{SID: "S-1-1-0", Inherited: true})
	if err := checkPrivateDACL(dacl, true, userSID); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("inherited Everyone accepted: %v", err)
	}
}

func TestStore_WindowsBroadOrForeignGrantsRejected(t *testing.T) {
	for name, sid := range map[string]string{
		"authenticated users": "S-1-5-11",
		"users":               "S-1-5-32-545",
		"guests":              "S-1-5-32-546",
		"anonymous":           "S-1-5-7",
		"interactive":         "S-1-5-4",
		"another user":        "S-1-5-21-1-2-3-1002",
		"app packages":        "S-1-15-2-1",
	} {
		dacl := append(defaultProfileDACL[:len(defaultProfileDACL):len(defaultProfileDACL)], aclEntry{SID: sid})
		if err := checkPrivateDACL(dacl, true, userSID); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("%s grant accepted: %v", name, err)
		}
	}
}

func TestStore_WindowsNullDACLRejected(t *testing.T) {
	if err := checkPrivateDACL(nil, false, userSID); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("a missing DACL grants everyone, accepted: %v", err)
	}
}

func TestStore_WindowsDACLWithoutTheUserRejected(t *testing.T) {
	if err := checkPrivateDACL(defaultProfileDACL[:2], true, userSID); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("a DACL the user cannot use accepted: %v", err)
	}
}

func TestStore_WindowsDenyEntriesNeverWidenAccess(t *testing.T) {
	dacl := append([]aclEntry{{SID: "S-1-1-0", Deny: true}}, defaultProfileDACL...)
	if err := checkPrivateDACL(dacl, true, userSID); err != nil {
		t.Fatalf("a deny entry for Everyone rejected: %v", err)
	}
}

func TestStore_WindowsUnknownUserSIDRejected(t *testing.T) {
	if err := checkPrivateDACL(defaultProfileDACL, true, ""); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("no user SID accepted: %v", err)
	}
}

func TestStore_WindowsOwnedByTheUserAccepted(t *testing.T) {
	if err := checkPrivateDir(userSID, defaultProfileDACL, true, userSID); err != nil {
		t.Fatal(err)
	}
}

func TestStore_WindowsOwnedByAnotherUserRejected(t *testing.T) {
	// A directory the attacker created and owns, granting only the victim:
	// the owner can rewrite the DACL whenever it likes.
	userOnly := []aclEntry{{SID: userSID}}
	for _, owner := range []string{"S-1-5-21-1-2-3-1002", "S-1-1-0", "S-1-5-32-545", ""} {
		if err := checkPrivateDir(owner, userOnly, true, userSID); !errors.Is(err, ErrUnsafePath) {
			t.Errorf("directory owned by %q accepted: %v", owner, err)
		}
	}
}

func TestStore_WindowsOwnedBySystemOrAdministratorsAccepted(t *testing.T) {
	for _, owner := range []string{sidSystem, sidAdministrators} {
		if err := checkPrivateDir(owner, defaultProfileDACL, true, userSID); err != nil {
			t.Errorf("owner %s refused: %v", owner, err)
		}
	}
}

func TestStore_WindowsOwnerCheckStillAppliesTheDACL(t *testing.T) {
	dacl := append(defaultProfileDACL[:len(defaultProfileDACL):len(defaultProfileDACL)], aclEntry{SID: "S-1-1-0", Inherited: true})
	if err := checkPrivateDir(userSID, dacl, true, userSID); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Everyone grant accepted under a user owner: %v", err)
	}
}
