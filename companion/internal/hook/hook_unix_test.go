// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package hook

import (
	"bytes"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// codingUID stands for the Hermes uid the socket serves; the test process's
// own uid is the Companion's and is never admitted.
func codingUID() int { return os.Getuid() + 1 }

// shortSocketDir is a 0711 directory this user owns whose socket path fits
// sun_path; t.TempDir() under a long test name does not.
func shortSocketDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bph")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.Chmod(dir, 0o711); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

// asCodingUID reports every peer as the coding uid, so this process can
// play the Hermes side.
func asCodingUID(net.Conn) (int, error) { return codingUID(), nil }

// recordingSink records what the server delivers and refuses.
type recordingSink struct {
	mu        sync.Mutex
	served    map[string]bool
	delivered []delivery
	refused   []error
}

type delivery struct {
	agent   string
	payload []byte
}

func newSink(agents ...string) *recordingSink {
	served := map[string]bool{}
	for _, agent := range agents {
		served[agent] = true
	}
	return &recordingSink{served: served}
}

func (s *recordingSink) Serves(agent string) bool { return s.served[agent] }

func (s *recordingSink) Deliver(agent string, payload []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.delivered = append(s.delivered, delivery{agent, bytes.Clone(payload)})
}

func (s *recordingSink) Refuse(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refused = append(s.refused, err)
}

func (s *recordingSink) deliveries() []delivery {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]delivery(nil), s.delivered...)
}

func (s *recordingSink) refusals() []error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]error(nil), s.refused...)
}

func serve(t *testing.T, path string, options Options, sink Sink) *Server {
	t.Helper()
	listener, err := Listen(path, options)
	if err != nil {
		t.Fatalf("Listen(%s): %v", path, err)
	}
	server := Serve(listener, sink)
	t.Cleanup(server.Close)
	return server
}

// send plays the plugin: one frame, half-close, read the reply until EOF.
func send(t *testing.T, path string, frame []byte) (reply string, err error) {
	t.Helper()
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err := conn.Write(frame); err != nil {
		return "", err
	}
	if err := conn.(*net.UnixConn).CloseWrite(); err != nil {
		return "", err
	}
	data, err := io.ReadAll(conn)
	return string(data), err
}

func frame(agent string, payload []byte) []byte {
	return append([]byte(agent+"\n"), payload...)
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if condition() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestListen_SocketIsWorldConnectableInsideAPrivateDirectory(t *testing.T) {
	dir := shortSocketDir(t)
	path := filepath.Join(dir, "hook.sock")
	listener, err := Listen(path, Options{PeerUID: codingUID()})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("no socket at %s: %v", path, err)
	}
	if info.Mode().Perm() != 0o666 {
		t.Fatalf("socket mode %o, want 0666 so the coding uid can connect", info.Mode().Perm())
	}
	if owner := info.Sys().(*syscall.Stat_t).Uid; int(owner) != os.Getuid() {
		t.Fatalf("socket owned by uid %d", owner)
	}
	listener.Close()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("closing the listener left the socket behind: %v", err)
	}
}

func TestListen_RefusesAnUnsafeDirectory(t *testing.T) {
	cases := []struct {
		name    string
		prepare func(t *testing.T) string
	}{
		{"group writable", func(t *testing.T) string {
			dir := shortSocketDir(t)
			os.Chmod(dir, 0o731)
			return filepath.Join(dir, "hook.sock")
		}},
		{"world writable", func(t *testing.T) string {
			dir := shortSocketDir(t)
			os.Chmod(dir, 0o713)
			return filepath.Join(dir, "hook.sock")
		}},
		{"symlinked directory", func(t *testing.T) string {
			real := shortSocketDir(t)
			link := filepath.Join(shortSocketDir(t), "d")
			os.Symlink(real, link)
			return filepath.Join(link, "hook.sock")
		}},
		{"missing directory", func(t *testing.T) string {
			return filepath.Join(shortSocketDir(t), "absent", "hook.sock")
		}},
		{"regular file at the leaf", func(t *testing.T) string {
			path := filepath.Join(shortSocketDir(t), "hook.sock")
			os.WriteFile(path, []byte("x"), 0o600)
			return path
		}},
		{"symlink at the leaf", func(t *testing.T) string {
			dir := shortSocketDir(t)
			other := filepath.Join(shortSocketDir(t), "other.sock")
			os.Symlink(other, filepath.Join(dir, "hook.sock"))
			return filepath.Join(dir, "hook.sock")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.prepare(t)
			listener, err := Listen(path, Options{PeerUID: codingUID()})
			if !errors.Is(err, ErrUnsafeDirectory) {
				if listener != nil {
					listener.Close()
				}
				t.Fatalf("want ErrUnsafeDirectory, got %v", err)
			}
			if err := CheckDirectory(path); !errors.Is(err, ErrUnsafeDirectory) {
				t.Fatalf("CheckDirectory: want ErrUnsafeDirectory, got %v", err)
			}
		})
	}
}

func TestCheckDirectory_AcceptsThePrivateDirectoryWithOrWithoutAStaleSocket(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	if err := CheckDirectory(path); err != nil {
		t.Fatalf("empty private directory refused: %v", err)
	}
	stale, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	if err := CheckDirectory(path); err != nil {
		t.Fatalf("a stale socket at the leaf refused: %v", err)
	}
}

func TestListen_RefusesPathsItCannotServe(t *testing.T) {
	dir := shortSocketDir(t)
	for _, path := range []string{"", "hook.sock", dir + "/./hook.sock", dir + "//hook.sock", dir + "/"} {
		listener, err := Listen(path, Options{PeerUID: codingUID()})
		if !errors.Is(err, ErrUnsafeDirectory) {
			if listener != nil {
				listener.Close()
			}
			t.Errorf("Listen(%q): want ErrUnsafeDirectory, got %v", path, err)
		}
	}
	long := filepath.Join(dir, strings.Repeat("s", 120)+".sock")
	if _, err := Listen(long, Options{PeerUID: codingUID()}); !errors.Is(err, ErrSocketPathTooLong) {
		t.Errorf("want ErrSocketPathTooLong, got %v", err)
	}
	// Refused at start too, not at the first verified session.
	if err := CheckDirectory(long); !errors.Is(err, ErrSocketPathTooLong) {
		t.Errorf("CheckDirectory: want ErrSocketPathTooLong, got %v", err)
	}
}

// The served uid runs arbitrary code: connections held open until the
// deadline must not grow the daemon's memory without bound.
func TestServe_ClosesConnectionsBeyondTheCapWithoutAReplyOrACount(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	server := serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	held := make([]net.Conn, 0, maxConnections)
	defer func() {
		for _, conn := range held {
			conn.Close()
		}
	}()
	for range maxConnections {
		conn, err := net.DialTimeout("unix", path, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Write([]byte("hermes\n")); err != nil {
			t.Fatal(err)
		}
		held = append(held, conn)
	}
	waitFor(t, "every held connection to be in flight", func() bool { return server.connections() == maxConnections })
	// The daemon closes the connection past the cap as soon as it accepts
	// it; depending on timing the client's write or half-close then fails
	// (EPIPE, ECONNRESET). Either way it gets no reply.
	reply, _ := send(t, path, frame("hermes", []byte(`{}`)))
	if reply != "" {
		t.Fatalf("the connection past the cap got reply %q; want closed without a reply", reply)
	}
	time.Sleep(50 * time.Millisecond)
	if len(sink.deliveries()) != 0 || len(sink.refusals()) != 0 {
		t.Fatalf("a connection past the cap reached the sink: %d deliveries, %d refusals", len(sink.deliveries()), len(sink.refusals()))
	}
	held[0].Close()
	waitFor(t, "a slot to free", func() bool { return server.connections() < maxConnections })
	if reply, err := send(t, path, frame("hermes", []byte(`{}`))); err != nil || reply != "{}\n" {
		t.Fatalf("after a slot freed: reply %q, err %v", reply, err)
	}
}

func TestListen_RefusesAPeerUIDThatWouldAdmitTheCompanionOrRoot(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	for _, uid := range []int{0, os.Getuid(), -1} {
		listener, err := Listen(path, Options{PeerUID: uid})
		if !errors.Is(err, ErrPeerUID) {
			if listener != nil {
				listener.Close()
			}
			t.Errorf("PeerUID %d: want ErrPeerUID, got %v", uid, err)
		}
	}
}

func TestListen_ReplacesAStaleSocketAndRefusesALiveOne(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	stale, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	listener, err := Listen(path, Options{PeerUID: codingUID()})
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	defer listener.Close()
	if _, err := Listen(path, Options{PeerUID: codingUID()}); !errors.Is(err, ErrSocketInUse) {
		t.Fatalf("a live socket: want ErrSocketInUse, got %v", err)
	}
}

func TestListen_RefusesASubstitutedLeaf(t *testing.T) {
	dir := shortSocketDir(t)
	path := filepath.Join(dir, "hook.sock")
	substituted := false
	_, err := Listen(path, Options{PeerUID: codingUID(), afterBind: func(path string) {
		os.Remove(path)
		os.Symlink(filepath.Join(dir, "elsewhere"), path)
		substituted = true
	}})
	if !substituted || !errors.Is(err, ErrSocketSubstituted) {
		t.Fatalf("want ErrSocketSubstituted after the leaf was swapped, got %v", err)
	}
	// The refusal closes the listener; what sits at the leaf is not ours to unlink.
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("closing the refused listener removed the substituted leaf: %v, %v", info, err)
	}
	os.Remove(path)
}

// Close unlinks the socket it bound, never whatever sits at the path by then.
func TestListen_CloseUnlinksOnlyItsOwnSocket(t *testing.T) {
	dir := shortSocketDir(t)
	path := filepath.Join(dir, "hook.sock")
	listener, err := Listen(path, Options{PeerUID: codingUID()})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	other, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	listener.Close()
	if info, err := os.Lstat(path); err != nil || info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("Close removed another socket at the path: %v, %v", info, err)
	}
	if conn, err := net.DialTimeout("unix", path, time.Second); err != nil {
		t.Fatalf("the other socket no longer answers: %v", err)
	} else {
		conn.Close()
	}
}

func TestServe_AcceptSurvivesATransientError(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	listener, err := Listen(path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID})
	if err != nil {
		t.Fatal(err)
	}
	flaky := &flakyListener{Listener: listener, failures: 3}
	server := Serve(flaky, sink)
	t.Cleanup(server.Close)
	reply, err := send(t, path, frame("hermes", []byte(`{}`)))
	if err != nil || reply != "{}\n" {
		t.Fatalf("after transient accept errors: reply %q, err %v", reply, err)
	}
	if flaky.seen.Load() < 3 {
		t.Fatalf("the transient errors were not exercised (%d)", flaky.seen.Load())
	}
}

// flakyListener fails the first accepts with a temporary error, as EMFILE
// under descriptor pressure does.
type flakyListener struct {
	net.Listener
	failures int32
	seen     atomic.Int32
}

type temporaryError struct{}

func (temporaryError) Error() string   { return "accept: too many open files" }
func (temporaryError) Temporary() bool { return true }
func (temporaryError) Timeout() bool   { return false }

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.seen.Load() < l.failures {
		l.seen.Add(1)
		return nil, temporaryError{}
	}
	return l.Listener.Accept()
}

// Uses the kernel's own peer credentials: this process is the Companion's
// uid, which is never the coding uid.
func TestServe_ClosesAPeerOfAnotherUIDWithoutAReplyOrADelivery(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID()}, sink)
	reply, err := send(t, path, frame("hermes", []byte(`{"hook_event_name":"on_session_start"}`)))
	if reply != "" {
		t.Fatalf("another uid got a reply %q (err %v)", reply, err)
	}
	time.Sleep(50 * time.Millisecond)
	if deliveries := sink.deliveries(); len(deliveries) != 0 {
		t.Fatalf("another uid's record was delivered: %v", deliveries)
	}
	if refused := sink.refusals(); len(refused) != 0 {
		t.Fatalf("a closed peer was counted as a hook error: %v", refused)
	}
}

func TestServe_ClosesAnUnidentifiablePeer(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: func(net.Conn) (int, error) { return 0, errors.New("no credentials") }}, sink)
	if reply, _ := send(t, path, frame("hermes", []byte(`{}`))); reply != "" {
		t.Fatalf("an unidentifiable peer got a reply %q", reply)
	}
	time.Sleep(50 * time.Millisecond)
	if len(sink.deliveries()) != 0 || len(sink.refusals()) != 0 {
		t.Fatal("an unidentifiable peer reached the sink")
	}
}

func TestServe_DeliversOneFramePerConnectionAndAnswersConsumed(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	payload := []byte(`{"hook_event_name":"on_session_start","session_id":"s"}` + "\n")
	reply, err := send(t, path, frame("hermes", payload))
	if err != nil || reply != "{}\n" {
		t.Fatalf("reply %q, err %v; want {} once the record is consumed", reply, err)
	}
	deliveries := sink.deliveries()
	if len(deliveries) != 1 || deliveries[0].agent != "hermes" || !bytes.Equal(deliveries[0].payload, payload) {
		t.Fatalf("deliveries %+v, want the payload after the agent line, byte for byte", deliveries)
	}
}

func TestServe_BoundsThePayloadAtExactly64KiB(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	atLimit := bytes.Repeat([]byte("a"), MaxPayloadBytes)
	if reply, err := send(t, path, frame("hermes", atLimit)); err != nil || reply != "{}\n" {
		t.Fatalf("%d bytes: reply %q, err %v; want consumed", MaxPayloadBytes, reply, err)
	}
	if deliveries := sink.deliveries(); len(deliveries) != 1 || len(deliveries[0].payload) != MaxPayloadBytes {
		t.Fatalf("the payload at the limit was not delivered whole: %d deliveries", len(deliveries))
	}
	overLimit := bytes.Repeat([]byte("a"), MaxPayloadBytes+1)
	if reply, _ := send(t, path, frame("hermes", overLimit)); reply != "" {
		t.Fatalf("%d bytes got a reply %q; an oversized record is closed without one", MaxPayloadBytes+1, reply)
	}
	waitFor(t, "the oversized record to be refused", func() bool { return len(sink.refusals()) == 1 })
	if refused := sink.refusals(); !errors.Is(refused[0], ErrPayloadTooLarge) || refused[0].Error() != "hook_payload_too_large" {
		t.Fatalf("refused with %v, want hook_payload_too_large", refused[0])
	}
	if len(sink.deliveries()) != 1 {
		t.Fatal("the oversized record was delivered")
	}
}

func TestServe_RefusesFramesItCannotRead(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	cases := []struct {
		name  string
		frame []byte
		want  error
	}{
		{"no newline", []byte("hermes"), ErrInvalidFraming},
		{"agent line too long", []byte(strings.Repeat("h", maxAgentIDBytes+1) + "\n{}"), ErrInvalidFraming},
		{"agent id with a control character", []byte("her\x00mes\n{}"), ErrInvalidFraming},
		{"unknown agent", frame("unknown-agent", []byte(`{}`)), ErrAgentNotServed},
		{"empty agent", frame("", []byte(`{}`)), ErrInvalidFraming},
	}
	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if reply, _ := send(t, path, tc.frame); reply != "" {
				t.Fatalf("got a reply %q; a frame that is not consumed gets none", reply)
			}
			waitFor(t, "the refusal to be counted", func() bool { return len(sink.refusals()) == index+1 })
			if refused := sink.refusals()[index]; !errors.Is(refused, tc.want) {
				t.Fatalf("refused with %v, want %v", refused, tc.want)
			}
		})
	}
	if len(sink.deliveries()) != 0 {
		t.Fatalf("an unreadable frame was delivered: %+v", sink.deliveries())
	}
}

// An agent line and EOF: the empty payload is the adapter's to refuse, so
// it is delivered and answered.
func TestServe_AnEarlyEOFAfterTheAgentLineIsDeliveredEmpty(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	reply, err := send(t, path, []byte("hermes\n"))
	if err != nil || reply != "{}\n" {
		t.Fatalf("reply %q, err %v", reply, err)
	}
	if deliveries := sink.deliveries(); len(deliveries) != 1 || len(deliveries[0].payload) != 0 {
		t.Fatalf("deliveries %+v", deliveries)
	}
}

// A connection that sends nothing is a liveness probe (the worker preflight,
// the Companion's own stale check): closed without a reply or a count.
func TestServe_AZeroByteConnectionIsAProbe(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	reply, err := send(t, path, nil)
	if err != nil || reply != "" {
		t.Fatalf("probe reply %q, err %v", reply, err)
	}
	time.Sleep(50 * time.Millisecond)
	if len(sink.deliveries()) != 0 || len(sink.refusals()) != 0 {
		t.Fatal("a probe reached the sink")
	}
}

func TestServe_CutsASlowClientAtTheDeadlineAndCleansUp(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	listener, err := Listen(path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID})
	if err != nil {
		t.Fatal(err)
	}
	server := serveWithin(listener, sink, 300*time.Millisecond)
	t.Cleanup(server.Close)
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hermes\n{\"partial\":")); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	data, _ := io.ReadAll(conn)
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("the slow client was held %v past the deadline", elapsed)
	}
	if len(data) != 0 {
		t.Fatalf("a cut client got %q", data)
	}
	waitFor(t, "the timeout to be counted", func() bool { return len(sink.refusals()) == 1 })
	if !errors.Is(sink.refusals()[0], ErrReadTimeout) {
		t.Fatalf("refused with %v, want ErrReadTimeout", sink.refusals()[0])
	}
	if len(sink.deliveries()) != 0 {
		t.Fatal("a partial record was delivered")
	}
	waitFor(t, "the connection goroutine to finish", func() bool { return server.connections() == 0 })
}

func TestServe_HandlesConcurrentWritersAndCloseWaitsForThem(t *testing.T) {
	path := filepath.Join(shortSocketDir(t), "hook.sock")
	sink := newSink("hermes")
	server := serve(t, path, Options{PeerUID: codingUID(), ReadPeerUID: asCodingUID}, sink)
	const writers = 24
	var group sync.WaitGroup
	for index := range writers {
		group.Add(1)
		go func() {
			defer group.Done()
			payload := []byte(strings.Repeat(string(rune('a'+index%26)), 100+index))
			if reply, err := send(t, path, frame("hermes", payload)); err != nil || reply != "{}\n" {
				t.Errorf("writer %d: reply %q, err %v", index, reply, err)
			}
		}()
	}
	group.Wait()
	if deliveries := sink.deliveries(); len(deliveries) != writers {
		t.Fatalf("%d deliveries, want %d", len(deliveries), writers)
	}
	server.Close()
	server.Close()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Close left the socket: %v", err)
	}
	if server.connections() != 0 {
		t.Fatal("Close returned with connections still open")
	}
	if _, err := net.DialTimeout("unix", path, 200*time.Millisecond); err == nil {
		t.Fatal("the socket still accepts after Close")
	}
}
