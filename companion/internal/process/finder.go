// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package process

import (
	"sync"
	"time"
)

// Process is a running process as the companion keeps it: its executable
// and start time, never its environment or arguments.
type Process struct {
	PID        int
	Executable string
	StartedAt  time.Time
}

// Query selects processes in two steps, so arguments are read only for the
// few processes whose executable already matched.
type Query struct {
	// Name keys the cache: one name always means the same selection.
	Name       string
	Executable func(path string) bool
	// Arguments decides from a candidate's argv, which is then dropped.
	Arguments func(argv []string) bool
}

type Finder interface {
	Find(Query) ([]Process, error)
}

// Table is the operating system's process table.
type Table interface {
	// List returns the current user's processes.
	List() ([]Process, error)
	Arguments(pids []int) (map[int][]string, error)
}

type cachedResult struct {
	processes []Process
	err       error
	at        time.Time
}

// CachedFinder answers each query from the table at most once per ttl, since
// agent status probes ask far more often than processes come and go.
type CachedFinder struct {
	table Table
	ttl   time.Duration
	now   func() time.Time
	logf  func(string)

	mu      sync.Mutex
	results map[string]cachedResult
	failing bool
}

func NewCachedFinder(table Table, ttl time.Duration, now func() time.Time, logf func(string)) *CachedFinder {
	return &CachedFinder{table: table, ttl: ttl, now: now, logf: logf, results: map[string]cachedResult{}}
}

// Find holds the lock while it reads the table so concurrent probes share
// one listing instead of each running ps.
func (f *CachedFinder) Find(query Query) ([]Process, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if cached, ok := f.results[query.Name]; ok && now.Sub(cached.at) < f.ttl && !now.Before(cached.at) {
		return cached.processes, cached.err
	}
	processes, err := f.find(query)
	f.results[query.Name] = cachedResult{processes: processes, err: err, at: now}
	switch {
	case err != nil && !f.failing:
		f.failing = true
		f.logf("process_list_failed: " + err.Error())
	case err == nil:
		f.failing = false
	}
	return processes, err
}

func (f *CachedFinder) find(query Query) ([]Process, error) {
	listed, err := f.table.List()
	if err != nil {
		return nil, err
	}
	var candidates []Process
	var pids []int
	for _, candidate := range listed {
		if query.Executable(candidate.Executable) {
			candidates = append(candidates, candidate)
			pids = append(pids, candidate.PID)
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	arguments, err := f.table.Arguments(pids)
	if err != nil {
		return nil, err
	}
	var found []Process
	for _, candidate := range candidates {
		if argv, ok := arguments[candidate.PID]; ok && query.Arguments(argv) {
			found = append(found, candidate)
		}
	}
	return found, nil
}
