package agent_test

import (
	"bytes"
	"io"
	"os"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

type unreadableRange struct {
	data   *bytes.Reader
	failAt func(int64) bool
}

func (r unreadableRange) ReadAt(p []byte, offset int64) (int, error) {
	if r.failAt(offset) {
		return 0, os.ErrClosed
	}
	return r.data.ReadAt(p, offset)
}

func TestSkippedRangeNeverTrustsFailedDigestReads(t *testing.T) {
	body := bytes.Repeat([]byte("x"), 16384)
	for _, test := range []struct {
		name   string
		failAt func(int64) bool
	}{
		{"both_windows", func(int64) bool { return true }},
		{"head_window", func(offset int64) bool { return offset == 0 }},
		{"tail_window", func(offset int64) bool { return offset > 0 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := unreadableRange{data: bytes.NewReader(body), failAt: test.failAt}
			skipped := agent.Skip(reader, 0, int64(len(body)))
			if skipped.Holds(reader, 0, int64(len(body))) {
				t.Fatal("failed digest reads authorized skipping an unverifiable range")
			}
		})
	}
}

func TestSkippedRangeKeepsAppendAndRejectsChangedOrUnreadableBytes(t *testing.T) {
	body := bytes.Repeat([]byte("x"), 16384)
	skipped := agent.Skip(bytes.NewReader(body), 0, int64(len(body)))
	appended := append(bytes.Clone(body), []byte("\na valid next record\n")...)
	changed := bytes.Clone(body)
	changed[0] = 'y'
	for _, test := range []struct {
		name   string
		reader io.ReaderAt
		size   int64
		want   bool
	}{
		{"unchanged", bytes.NewReader(body), int64(len(body)), true},
		{"appended", bytes.NewReader(appended), int64(len(appended)), true},
		{"rewritten", bytes.NewReader(changed), int64(len(changed)), false},
		{"unreadable", unreadableRange{bytes.NewReader(body), func(int64) bool { return true }}, int64(len(body)), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := skipped.Holds(test.reader, 0, test.size); got != test.want {
				t.Fatalf("Holds = %v, want %v", got, test.want)
			}
		})
	}
}
