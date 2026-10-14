// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import "golang.org/x/sys/unix"

func socketPeerUID(fd int) (int, error) {
	credentials, err := unix.GetsockoptUcred(fd, unix.SOL_SOCKET, unix.SO_PEERCRED)
	if err != nil {
		return 0, err
	}
	return int(credentials.Uid), nil
}
