// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package collector

import (
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var daemonJob struct {
	once   sync.Once
	handle windows.Handle
	err    error
}

// bindToDaemon puts the collector in a job object with KILL_ON_JOB_CLOSE.
// The daemon keeps the only job handle open for its lifetime (it is created
// non-inheritable), so when the daemon exits by any means, including
// TerminateProcess or schtasks /End, Windows closes the handle and kills the
// collector. Windows has no parent-death signal, and the pid-file reaping in
// reapOrphan cannot verify a command line here.
func bindToDaemon(collector *os.Process) error {
	daemonJob.once.Do(func() { daemonJob.handle, daemonJob.err = newKillOnCloseJob() })
	if daemonJob.err != nil {
		return daemonJob.err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(collector.Pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.AssignProcessToJobObject(daemonJob.handle, handle)
}

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}
