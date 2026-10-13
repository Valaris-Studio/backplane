// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package process

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTable is a process table in memory; no real process is ever listed.
type fakeTable struct {
	mu            sync.Mutex
	processes     []Process
	argv          map[int][]string
	listErr       error
	lists         int
	argumentsFor  [][]int
	argumentsErrs error
}

func (f *fakeTable) List() ([]Process, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lists++
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]Process(nil), f.processes...), nil
}

func (f *fakeTable) Arguments(pids []int) (map[int][]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.argumentsFor = append(f.argumentsFor, append([]int(nil), pids...))
	if f.argumentsErrs != nil {
		return nil, f.argumentsErrs
	}
	found := map[int][]string{}
	for _, pid := range pids {
		if argv, ok := f.argv[pid]; ok {
			found[pid] = argv
		}
	}
	return found, nil
}

type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

var started = time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)

const appServer = "/Applications/ChatGPT.app/Contents/Resources/codex"

func appServerQuery() Query {
	return Query{
		Name:       "codex-app-server",
		Executable: func(path string) bool { return path == appServer },
		Arguments: func(argv []string) bool {
			for _, arg := range argv {
				if arg == "app-server" {
					return true
				}
			}
			return false
		},
	}
}

func newFinder(table Table) (*CachedFinder, *clock, *[]string) {
	c := &clock{at: started.Add(7 * 24 * time.Hour)}
	var logged []string
	return NewCachedFinder(table, 5*time.Second, c.now, func(line string) { logged = append(logged, line) }), c, &logged
}

func TestFind_ReadsArgumentsOnlyForExecutableMatches(t *testing.T) {
	table := &fakeTable{
		processes: []Process{
			{PID: 10, Executable: appServer, StartedAt: started},
			{PID: 11, Executable: "/bin/zsh", StartedAt: started},
			{PID: 12, Executable: appServer, StartedAt: started},
		},
		argv: map[int][]string{10: {appServer, "app-server"}, 11: {"/bin/zsh", "secret"}, 12: {appServer, "exec"}},
	}
	finder, _, _ := newFinder(table)
	found, err := finder.Find(appServerQuery())
	if err != nil {
		t.Fatal(err)
	}
	if want := []Process{{PID: 10, Executable: appServer, StartedAt: started}}; !reflect.DeepEqual(found, want) {
		t.Fatalf("found %+v, want %+v", found, want)
	}
	if want := [][]int{{10, 12}}; !reflect.DeepEqual(table.argumentsFor, want) {
		t.Fatalf("arguments were read for %v, want only the executable matches %v", table.argumentsFor, want)
	}
}

func TestFind_NoCandidateReadsNoArguments(t *testing.T) {
	table := &fakeTable{processes: []Process{{PID: 11, Executable: "/bin/zsh", StartedAt: started}}}
	finder, _, _ := newFinder(table)
	found, err := finder.Find(appServerQuery())
	if err != nil || len(found) != 0 {
		t.Fatalf("found %v, %v; want nothing", found, err)
	}
	if len(table.argumentsFor) != 0 {
		t.Fatalf("arguments were read for %v with no candidate", table.argumentsFor)
	}
}

func TestFind_CachesWithinTheTTLAndRereadsAfter(t *testing.T) {
	table := &fakeTable{processes: []Process{{PID: 10, Executable: appServer, StartedAt: started}}, argv: map[int][]string{10: {appServer, "app-server"}}}
	finder, c, _ := newFinder(table)
	finder.Find(appServerQuery())
	c.at = c.at.Add(4 * time.Second)
	finder.Find(appServerQuery())
	if table.lists != 1 {
		t.Fatalf("listed %d times within the TTL, want 1", table.lists)
	}

	// The app restarted: after the TTL the new process is seen.
	restarted := started.Add(8 * 24 * time.Hour)
	table.mu.Lock()
	table.processes = []Process{{PID: 20, Executable: appServer, StartedAt: restarted}}
	table.argv = map[int][]string{20: {appServer, "app-server"}}
	table.mu.Unlock()
	c.at = c.at.Add(2 * time.Second)
	found, _ := finder.Find(appServerQuery())
	if table.lists != 2 || len(found) != 1 || found[0].PID != 20 {
		t.Fatalf("after the TTL: lists=%d found=%+v, want a fresh read with pid 20", table.lists, found)
	}
}

func TestFind_ListErrorFailsQuietAndLogsOncePerStreak(t *testing.T) {
	table := &fakeTable{listErr: errors.New("ps: timed out")}
	finder, c, logged := newFinder(table)
	for range 3 {
		if _, err := finder.Find(appServerQuery()); err == nil {
			t.Fatal("a failed listing must be reported to the caller")
		}
		c.at = c.at.Add(6 * time.Second)
	}
	if len(*logged) != 1 || !strings.Contains((*logged)[0], "process_list_failed") {
		t.Fatalf("logged %q, want one process_list_failed line for the streak", *logged)
	}

	table.mu.Lock()
	table.listErr = nil
	table.mu.Unlock()
	if _, err := finder.Find(appServerQuery()); err != nil {
		t.Fatalf("recovered listing: %v", err)
	}
	table.mu.Lock()
	table.listErr = errors.New("ps: failed again")
	table.mu.Unlock()
	c.at = c.at.Add(6 * time.Second)
	finder.Find(appServerQuery())
	if len(*logged) != 2 {
		t.Fatalf("a new failure streak after a success logs again; got %q", *logged)
	}
}

func TestFind_ArgumentsErrorIsAnError(t *testing.T) {
	table := &fakeTable{processes: []Process{{PID: 10, Executable: appServer, StartedAt: started}}, argumentsErrs: errors.New("ps: exit 1")}
	finder, _, logged := newFinder(table)
	if _, err := finder.Find(appServerQuery()); err == nil {
		t.Fatal("unreadable arguments must not be taken as a match or a non-match")
	}
	if len(*logged) != 1 {
		t.Fatalf("logged %q, want one line", *logged)
	}
}

func TestFind_ErrorsAreCachedForTheTTL(t *testing.T) {
	table := &fakeTable{listErr: errors.New("ps: timed out")}
	finder, c, _ := newFinder(table)
	finder.Find(appServerQuery())
	c.at = c.at.Add(time.Second)
	finder.Find(appServerQuery())
	if table.lists != 1 {
		t.Fatalf("a failing ps ran %d times within the TTL, want 1", table.lists)
	}
}
