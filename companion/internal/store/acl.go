// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package store

import "fmt"

// Well-known SIDs a user-private Windows directory may grant.
const (
	sidSystem         = "S-1-5-18"
	sidAdministrators = "S-1-5-32-544"
	// CREATOR OWNER stands for whoever creates a child, which in the
	// companion's own directory is the user.
	sidCreatorOwner = "S-1-3-0"
)

// aclEntry is one DACL entry, reduced to what the privacy check reads.
type aclEntry struct {
	SID       string
	Deny      bool
	Inherited bool
}

// checkPrivateDACL is the Windows counterpart of mode 0700: only the user
// may be granted access. SYSTEM and Administrators are the default profile
// ACL and can already read every profile through backup and take-ownership
// privileges, so their entries grant nothing new. A missing (null) DACL
// grants everyone everything.
func checkPrivateDACL(entries []aclEntry, present bool, userSID string) error {
	if userSID == "" {
		return fmt.Errorf("%w: current user unknown", ErrUnsafePath)
	}
	if !present {
		return fmt.Errorf("%w: directory has no access list", ErrUnsafePath)
	}
	userGranted := false
	for _, entry := range entries {
		if entry.Deny {
			continue
		}
		switch entry.SID {
		case userSID:
			userGranted = true
		case sidSystem, sidAdministrators, sidCreatorOwner:
		default:
			origin := "explicit"
			if entry.Inherited {
				origin = "inherited"
			}
			return fmt.Errorf("%w: directory grants %s access (%s)", ErrUnsafePath, entry.SID, origin)
		}
	}
	if !userGranted {
		return fmt.Errorf("%w: directory does not grant the user access", ErrUnsafePath)
	}
	return nil
}

// checkPrivateDir adds the owner to checkPrivateDACL, since an owner can
// rewrite the DACL at any time: a directory another user created and owns
// stays theirs however narrow its entries look. SYSTEM and Administrators
// may own it (an elevated creator's default owner is Administrators) because
// they can take ownership of any file anyway.
func checkPrivateDir(owner string, entries []aclEntry, present bool, userSID string) error {
	if userSID == "" {
		return fmt.Errorf("%w: current user unknown", ErrUnsafePath)
	}
	switch owner {
	case userSID, sidSystem, sidAdministrators:
	default:
		return fmt.Errorf("%w: directory is owned by %q", ErrUnsafePath, owner)
	}
	return checkPrivateDACL(entries, present, userSID)
}
