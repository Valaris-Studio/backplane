// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// daemonControlTimeout bounds each call the CLI makes to a running daemon.
const daemonControlTimeout = 10 * time.Second

// cancelDaemonPairing cancels the code a running daemon is waiting on, as
// the desktop's sign-out does. A code already approved is persisting and is
// refused: signing out under it would race the switch. Without a running
// daemon there is nothing to cancel.
func (a *app) cancelDaemonPairing(ctx context.Context, layout store.Layout) error {
	if !daemonRunning(layout) {
		return nil
	}
	client := &http.Client{
		Timeout: daemonControlTimeout,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return control.Dial(ctx, layout.Root)
		}},
	}
	defer client.CloseIdleConnections()
	call := func(method, path string) (int, []byte, error) {
		request, err := http.NewRequestWithContext(ctx, method, "http://companion"+path, nil)
		if err != nil {
			return 0, nil, err
		}
		reply, err := client.Do(request)
		if err != nil {
			return 0, nil, err
		}
		defer reply.Body.Close()
		body, err := io.ReadAll(io.LimitReader(reply.Body, 1<<20))
		return reply.StatusCode, body, err
	}
	status, body, err := call(http.MethodGet, "/v1/pair")
	if err != nil || status != http.StatusOK {
		// No control API answering, or no code waiting.
		return nil
	}
	var pending struct {
		ID string `json:"pairing_id"`
	}
	if json.Unmarshal(body, &pending) != nil || pending.ID == "" {
		return nil
	}
	status, _, err = call(http.MethodDelete, "/v1/pair/"+pending.ID)
	if err != nil {
		return err
	}
	if status == http.StatusConflict {
		return errSwitchInProgress
	}
	return nil
}
