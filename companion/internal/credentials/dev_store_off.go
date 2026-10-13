// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !devkeyring

package credentials

// Release builds carry no file-backed credential store.
const devStoreBuilt = false

func newDevStore(string) Store { return nil }
