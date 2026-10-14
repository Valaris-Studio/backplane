// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pstable

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/process"
)

// psPath is absolute so PATH can never pick another ps.
const psPath = "/bin/ps"

// psTimeout bounds each ps run; the agent status probe waits on it.
const psTimeout = 2 * time.Second

// SystemTable lists processes with ps. Only the executable path and start
// time are read for every process; arguments only for the pids asked for.
func SystemTable() process.Table { return psTable{uid: os.Getuid()} }

type psTable struct{ uid int }

func (t psTable) List() ([]process.Process, error) {
	output, err := runPS("-axww", "-o", "pid=,uid=,lstart=,comm=")
	if err != nil {
		return nil, err
	}
	return parseList(output, t.uid), nil
}

func (psTable) Arguments(pids []int) (map[int][]string, error) {
	listed := make([]string, len(pids))
	for index, pid := range pids {
		listed[index] = strconv.Itoa(pid)
	}
	output, err := runPS("-ww", "-o", "pid=,args=", "-p", strings.Join(listed, ","))
	var exit *exec.ExitError
	// ps exits 1 when none of the pids still runs.
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 1 && len(output) == 0) {
		return nil, err
	}
	return parseArguments(output), nil
}

// runPS runs with a minimal environment: C locale for English day and month
// names, and UTC so start times parse without the local zone.
func runPS(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), psTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, psPath, args...)
	command.Env = []string{"LC_ALL=C", "TZ=UTC0"}
	return command.Output()
}
