// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package process answers whether a recorded process id still runs, so a
// lock left held by something other than a live daemon is not mistaken for
// one, and finds running agent apps by executable and start time.
package process
