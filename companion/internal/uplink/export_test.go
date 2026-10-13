// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink

import "time"

// SetDeadlines shortens the per-request deadlines for a test.
func SetDeadlines(json, chunk time.Duration) (restore func()) {
	previousJSON, previousChunk := jsonDeadline, chunkDeadline
	jsonDeadline, chunkDeadline = json, chunk
	return func() { jsonDeadline, chunkDeadline = previousJSON, previousChunk }
}

// HasGlobalTimeout reports whether the client bounds every request alike.
func (c *Client) HasGlobalTimeout() bool { return c.http.Timeout != 0 }
