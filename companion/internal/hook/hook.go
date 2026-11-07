// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package hook serves the headless Companion's hook socket: the one local
// transport by which a coding agent running as another uid hands the
// Companion a hook record. Only the configured peer uid is served, one
// record per connection, and the record is handled in the Companion's own
// process, so the coding uid never writes anything durable.
package hook

import (
	"bufio"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// MaxPayloadBytes bounds the record after the agent line; exactly this
	// many bytes pass.
	MaxPayloadBytes = 64 << 10
	// maxAgentIDBytes bounds the agent line, without its newline.
	maxAgentIDBytes = 64
	// connectionDeadline bounds every connection, read and reply included.
	connectionDeadline = 5 * time.Second
	// acceptRetryDelay paces the accept loop after a temporary error.
	acceptRetryDelay = 50 * time.Millisecond
	// maxConnections bounds the memory the served uid can hold open at
	// once (each connection buffers at most the payload bound). The plugin
	// forwards one record at a time, so real use stays far below it.
	maxConnections = 64
)

var (
	// ErrUnsafeDirectory refuses a socket directory another uid could write,
	// a symlink as the directory or the leaf, and anything but a socket at
	// the leaf.
	ErrUnsafeDirectory = errors.New("unsafe_hook_directory")
	// ErrSocketSubstituted is a leaf that is not this uid's socket right
	// after the bind.
	ErrSocketSubstituted = errors.New("hook_socket_substituted")
	// ErrSocketInUse is a live listener at the socket path.
	ErrSocketInUse = errors.New("hook_socket_in_use")
	// ErrSocketPathTooLong is a path past sun_path.
	ErrSocketPathTooLong = errors.New("hook_socket_path_too_long")
	// ErrPeerUID is a peer uid that would admit root or the Companion itself.
	ErrPeerUID = errors.New("hook_peer_uid_invalid")
	// ErrUnsupportedPlatform: headless mode, and so the socket, is Unix-only.
	ErrUnsupportedPlatform = errors.New("unsupported_platform")

	// Content-free health codes for frames the socket does not consume.
	ErrInvalidFraming  = errors.New("hook_invalid_framing")
	ErrAgentNotServed  = errors.New("hook_agent_not_served")
	ErrPayloadTooLarge = errors.New("hook_payload_too_large")
	ErrReadTimeout     = errors.New("hook_read_timeout")
)

// Sink is what consumes the frames: the Companion's hook shim.
type Sink interface {
	// Serves reports whether agent names a registered adapter the socket
	// delivers for.
	Serves(agent string) bool
	// Deliver handles one record; the sink counts its own refusals.
	Deliver(agent string, payload []byte)
	// Refuse counts a frame the socket itself refused.
	Refuse(err error)
}

type Options struct {
	// PeerUID is the only peer uid served: the coding agent's. It is never
	// 0 and never this process's own uid.
	PeerUID int
	// ReadPeerUID reads the connecting process's uid; nil means the kernel's
	// peer credentials. Tests replace it.
	ReadPeerUID func(net.Conn) (int, error)
	// afterBind observes the socket right after it is bound (tests).
	afterBind func(path string)
}

// Server accepts frames of the form "<agent-id>\n<payload>" and answers
// "{}\n" once a frame was consumed: observation never becomes a decision.
type Server struct {
	listener net.Listener
	sink     Sink
	deadline time.Duration
	active   atomic.Int32
	group    sync.WaitGroup
	once     sync.Once
}

// Serve starts accepting on listener, which Listen returned.
func Serve(listener net.Listener, sink Sink) *Server {
	return serveWithin(listener, sink, connectionDeadline)
}

func serveWithin(listener net.Listener, sink Sink, deadline time.Duration) *Server {
	server := &Server{listener: listener, sink: sink, deadline: deadline}
	server.group.Add(1)
	go server.accept()
	return server
}

// Close stops accepting, unlinks the socket and waits for the connections
// in flight, each bounded by the deadline. It is safe to call twice.
func (s *Server) Close() {
	s.once.Do(func() { s.listener.Close() })
	s.group.Wait()
}

func (s *Server) connections() int { return int(s.active.Load()) }

func (s *Server) accept() {
	defer s.group.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			// Descriptor pressure (EMFILE) is temporary: the socket stays
			// bound, so accepting must resume rather than stop for good.
			var temporary interface{ Temporary() bool }
			if errors.As(err, &temporary) && temporary.Temporary() && !errors.Is(err, net.ErrClosed) {
				time.Sleep(acceptRetryDelay)
				continue
			}
			return
		}
		// Past the cap the connection is closed without a reply or a
		// count, like a foreign peer: the plugin counts it lost.
		if int(s.active.Load()) >= maxConnections {
			conn.Close()
			continue
		}
		s.group.Add(1)
		s.active.Add(1)
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer s.group.Done()
	defer s.active.Add(-1)
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(s.deadline))
	reader := bufio.NewReaderSize(conn, 4096)
	agent, probe, err := readAgentLine(reader)
	if probe {
		return
	}
	if err != nil {
		s.sink.Refuse(err)
		return
	}
	if !s.sink.Serves(agent) {
		s.sink.Refuse(ErrAgentNotServed)
		return
	}
	payload, err := io.ReadAll(io.LimitReader(reader, MaxPayloadBytes+1))
	if err != nil {
		s.sink.Refuse(classifyRead(err))
		return
	}
	if len(payload) > MaxPayloadBytes {
		s.sink.Refuse(ErrPayloadTooLarge)
		return
	}
	s.sink.Deliver(agent, payload)
	conn.Write([]byte("{}\n"))
}

// readAgentLine reads "<agent-id>\n". A connection closed before any byte is
// a liveness probe, not a frame.
func readAgentLine(reader *bufio.Reader) (agent string, probe bool, err error) {
	line := make([]byte, 0, 32)
	for {
		next, err := reader.ReadByte()
		if err != nil {
			if len(line) == 0 && errors.Is(err, io.EOF) {
				return "", true, nil
			}
			return "", false, classifyRead(err)
		}
		if next == '\n' {
			break
		}
		if len(line) == maxAgentIDBytes || next <= ' ' || next >= 0x7f {
			return "", false, ErrInvalidFraming
		}
		line = append(line, next)
	}
	if len(line) == 0 {
		return "", false, ErrInvalidFraming
	}
	return string(line), false, nil
}

func classifyRead(err error) error {
	var timeout interface{ Timeout() bool }
	if errors.As(err, &timeout) && timeout.Timeout() {
		return ErrReadTimeout
	}
	return ErrInvalidFraming
}
