// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package pstable reads the process table with ps. It is kept apart from
// package process so the hook shim, which must never run a program, does
// not link os/exec.
package pstable

import (
	"bufio"
	"bytes"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/process"
)

// psStartLayout is ps's lstart column under LC_ALL=C; the day is padded
// with a space, which strings.Fields absorbs.
const psStartLayout = "Mon Jan 2 15:04:05 2006"

// parseList reads `ps -o pid=,uid=,lstart=,comm=` run with TZ=UTC0, keeping
// uid's processes. The executable is the rest of the line: paths have spaces.
func parseList(output []byte, uid int) []process.Process {
	var processes []process.Process
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 8 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		owner, uidErr := strconv.Atoi(fields[1])
		startedAt, startErr := time.ParseInLocation(psStartLayout, strings.Join(fields[2:7], " "), time.UTC)
		if pidErr != nil || uidErr != nil || startErr != nil || owner != uid {
			continue
		}
		processes = append(processes, process.Process{PID: pid, Executable: afterFields(scanner.Text(), 7), StartedAt: startedAt})
	}
	return processes
}

// afterFields is line without its first count space-separated fields.
func afterFields(line string, count int) string {
	for range count {
		line = strings.TrimLeft(line, " \t")
		line = line[strings.IndexAny(line+" ", " \t"):]
	}
	return strings.TrimSpace(line)
}

// parseArguments reads `ps -o pid=,args=`. Arguments are split on spaces,
// which is enough to recognize a subcommand word.
func parseArguments(output []byte) map[int][]string {
	arguments := map[int][]string{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		arguments[pid] = fields[1:]
	}
	return arguments
}
