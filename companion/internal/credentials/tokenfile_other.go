// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !unix

package credentials

// Without openat and owner/mode bits, a token file cannot be proven safe
// here, so file mode is refused.

func ReadTokenFile(TokenFileSpec) (string, FileIdentity, error) {
	return "", FileIdentity{}, ErrFileCredentialUnsupported
}

func StatTokenFile(string) (FileIdentity, error) {
	return FileIdentity{}, ErrFileCredentialUnsupported
}
