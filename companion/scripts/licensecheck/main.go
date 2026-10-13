// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Command licensecheck reports, for each license file named on stdin (one
// JSON array of paths), which licenses github.com/google/licensecheck finds
// and how much of the text they cover. The bundle build decides on it.
package main

import (
	"encoding/json"
	"os"

	"github.com/google/licensecheck"
)

type match struct {
	ID    string `json:"id"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	// IsURL marks a license named only by its URL, not its text.
	IsURL bool `json:"is_url"`
}

type report struct {
	Path    string  `json:"path"`
	Percent float64 `json:"percent"`
	Matches []match `json:"matches"`
}

func main() {
	var paths []string
	if err := json.NewDecoder(os.Stdin).Decode(&paths); err != nil {
		fail(err)
	}
	reports := make([]report, 0, len(paths))
	for _, path := range paths {
		text, err := os.ReadFile(path)
		if err != nil {
			fail(err)
		}
		coverage := licensecheck.Scan(text)
		found := report{Path: path, Percent: coverage.Percent, Matches: []match{}}
		for _, m := range coverage.Match {
			found.Matches = append(found.Matches, match{ID: m.ID, Start: m.Start, End: m.End, IsURL: m.IsURL})
		}
		reports = append(reports, found)
	}
	if err := json.NewEncoder(os.Stdout).Encode(reports); err != nil {
		fail(err)
	}
}

func fail(err error) {
	os.Stderr.WriteString("licensecheck: " + err.Error() + "\n")
	os.Exit(1)
}
