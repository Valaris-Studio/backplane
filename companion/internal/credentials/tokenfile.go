// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import "errors"

// TokenFileSpec names an operator-provisioned token file and the owner it
// must have. Its ancestors must be owned by root or UID.
type TokenFileSpec struct {
	Path string
	UID  int
	GID  int
}

// FileIdentity is what a reload watcher compares to notice a token file
// replaced, rewritten, touched, chmodded or chowned.
type FileIdentity struct {
	Dev, Ino         uint64
	Size             int64
	MtimeNs, CtimeNs int64
	Mode             uint32
	UID, GID         uint32
}

var (
	ErrCredentialMissing         = errors.New("credential_missing")
	ErrCredentialMalformed       = errors.New("credential_malformed")
	ErrCredentialUnsafe          = errors.New("credential_unsafe")
	ErrCredentialUnreadable      = errors.New("credential_unreadable")
	ErrReadOnlyCredential        = errors.New("credential_read_only")
	ErrFileCredentialUnsupported = errors.New("file_credential_unsupported")
)

// UnsafeCredentialError names the token-file rule a path or file broke.
type UnsafeCredentialError struct{ Check string }

func (e UnsafeCredentialError) Error() string        { return "credential_unsafe:" + e.Check }
func (e UnsafeCredentialError) Is(target error) bool { return target == ErrCredentialUnsafe }

// TokenFileStore is the Store for one installation whose token the operator
// manages as a file: it only reads.
type TokenFileStore struct {
	Spec           TokenFileSpec
	InstallationID string
}

func (s TokenFileStore) Load(installationID string) (string, error) {
	if installationID != s.InstallationID {
		return "", ErrNotFound
	}
	token, _, err := ReadTokenFile(s.Spec)
	return token, err
}

func (TokenFileStore) Save(string, string) error { return ErrReadOnlyCredential }
func (TokenFileStore) Delete(string) error       { return ErrReadOnlyCredential }
