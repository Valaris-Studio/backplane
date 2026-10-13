// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package mcplaunch

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// MCP's stdio transport is newline-delimited JSON-RPC. The proxy copies it
// byte for byte in both directions with one exception: the result of the
// agent's initialize request gets the board paragraph in its instructions.
// Anything it cannot parse passes through untouched.

type proxy struct {
	boardContext string
	mu           sync.Mutex
	// initializeIDs are the compacted ids of initialize requests whose
	// response has not arrived yet.
	initializeIDs map[string]bool
}

func newProxy(boardContext string) *proxy {
	return &proxy{boardContext: boardContext, initializeIDs: map[string]bool{}}
}

// Proxy copies both directions until both ends are done.
func Proxy(clientIn io.Reader, clientOut io.Writer, serverIn io.WriteCloser, serverOut io.Reader, boardContext string) error {
	session := newProxy(boardContext)
	var clientDone sync.WaitGroup
	clientDone.Add(1)
	go func() {
		defer clientDone.Done()
		session.clientToServer(clientIn, serverIn)
	}()
	err := session.serverToClient(serverOut, clientOut)
	clientDone.Wait()
	return err
}

// clientToServer records initialize ids before forwarding each line, so the
// response can never arrive before its id is known; it closes the server's
// input when the agent closes its end.
func (p *proxy) clientToServer(clientIn io.Reader, serverIn io.WriteCloser) {
	defer serverIn.Close()
	reader := bufio.NewReader(clientIn)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if id, ok := initializeID(line); ok {
				p.mu.Lock()
				p.initializeIDs[id] = true
				p.mu.Unlock()
			}
			if _, writeErr := serverIn.Write(line); writeErr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (p *proxy) serverToClient(serverOut io.Reader, clientOut io.Writer) error {
	reader := bufio.NewReader(serverOut)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if _, writeErr := clientOut.Write(p.rewrite(line)); writeErr != nil {
				return writeErr
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func initializeID(line []byte) (string, bool) {
	if !bytes.Contains(line, []byte("initialize")) {
		return "", false
	}
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
	}
	if json.Unmarshal(line, &request) != nil || request.Method != "initialize" {
		return "", false
	}
	return compactID(request.ID)
}

func compactID(raw json.RawMessage) (string, bool) {
	var compacted bytes.Buffer
	if len(raw) == 0 || json.Compact(&compacted, raw) != nil || compacted.String() == "null" {
		return "", false
	}
	return compacted.String(), true
}

// takeInitialize reports whether id answers a pending initialize, and
// forgets it: a later message reusing the id is not rewritten.
func (p *proxy) takeInitialize(raw json.RawMessage) bool {
	id, ok := compactID(raw)
	p.mu.Lock()
	defer p.mu.Unlock()
	if !ok || !p.initializeIDs[id] {
		return false
	}
	delete(p.initializeIDs, id)
	return true
}

func (p *proxy) rewrite(line []byte) []byte {
	p.mu.Lock()
	pending := len(p.initializeIDs) > 0
	p.mu.Unlock()
	if !pending {
		return line
	}
	body := bytes.TrimRight(line, "\r\n")
	ending := line[len(body):]
	var message map[string]json.RawMessage
	if json.Unmarshal(body, &message) != nil || !p.takeInitialize(message["id"]) {
		return line
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(message["result"], &result) != nil || result == nil {
		return line
	}
	instructions := p.boardContext
	if raw, present := result["instructions"]; present {
		var existing string
		if json.Unmarshal(raw, &existing) != nil {
			return line
		}
		if existing != "" {
			instructions += "\n\n" + existing
		}
	}
	result["instructions"] = encode(instructions)
	message["result"] = encode(result)
	return append(encode(message), ending...)
}

// encode is compact JSON that keeps <, > and & as they are.
func encode(value any) json.RawMessage {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.Encode(value)
	return bytes.TrimRight(buffer.Bytes(), "\n")
}
