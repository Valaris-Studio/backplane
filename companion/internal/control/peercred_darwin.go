// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import "golang.org/x/sys/unix"

// socketPeerUID reads LOCAL_PEERCRED, which getpeereid(3) wraps.
func socketPeerUID(fd int) (int, error) {
	credentials, err := unix.GetsockoptXucred(fd, unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	if err != nil {
		return 0, err
	}
	return int(credentials.Uid), nil
}
