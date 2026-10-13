// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package queue

import (
	"os"
	"testing"
)

// makeUnreadable leaves a record the queue refuses to read. Windows has no
// per-file mode to widen and its handles do not stop os.Open, so the record
// grows past the size a record may have.
func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	// store.ReadPrivateFile refuses it: "not a bounded regular file".
	if err := os.Truncate(path, MaxRecordBytes+1); err != nil {
		t.Fatal(err)
	}
}
