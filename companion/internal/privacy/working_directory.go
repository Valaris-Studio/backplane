// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"net/url"
	"path"
	"regexp"
	"strings"
)

// workingDirectoryMembers name a session's working directory wherever an
// event carries it, Beacon's raw copy of the native payload included.
var workingDirectoryMembers = map[string]bool{"cwd": true, "working_directory": true, "workdir": true}

var driveRoot = regexp.MustCompile(`^[A-Za-z]:$`)

type directoryPath struct {
	components []string
	separator  string
	windows    bool
	unc        bool
}

func parseWorkingDirectory(value string) (directoryPath, bool) {
	candidate := strings.TrimSpace(value)
	if len(candidate) >= len("file://") && strings.EqualFold(candidate[:len("file://")], "file://") {
		parsed, err := url.Parse(candidate)
		if err != nil {
			return directoryPath{}, false
		}
		candidate = parsed.Path
		if parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost") {
			candidate = `\\` + parsed.Host + strings.ReplaceAll(candidate, "/", `\`)
		} else if driveAfterSlash.MatchString(candidate) {
			candidate = candidate[1:]
		}
	}
	const verbatimUNC = `\\?\UNC\`
	if len(candidate) >= len(verbatimUNC) && strings.EqualFold(candidate[:len(verbatimUNC)], verbatimUNC) {
		candidate = `\\` + candidate[len(verbatimUNC):]
	} else {
		candidate = extendedPrefix.ReplaceAllString(candidate, "$1")
	}
	rootedWindows := strings.HasPrefix(candidate, `\`)
	if !AbsolutePath(candidate) && !rootedWindows {
		return directoryPath{}, false
	}
	directory := directoryPath{
		separator: "/",
		windows:   drivePath.MatchString(candidate) || rootedWindows,
		unc:       strings.HasPrefix(candidate, `\\`),
	}
	if directory.windows {
		if strings.Contains(candidate, `\`) {
			directory.separator = `\`
		}
		candidate = strings.ReplaceAll(candidate, `\`, "/")
	}
	directory.components = strings.Split(path.Clean(candidate), "/")
	return directory, true
}

func (p placer) workingDirectory(value string) string {
	directory, ok := parseWorkingDirectory(value)
	if !ok {
		return value
	}
	for _, root := range p.roots {
		base, ok := parseWorkingDirectory(root.path)
		if !ok || base.windows != directory.windows || base.unc != directory.unc || len(base.components) > len(directory.components) {
			continue
		}
		matched := true
		for index, component := range base.components {
			other := directory.components[index]
			if component != other && (!(base.windows || caseInsensitiveRoot.MatchString(root.path)) || !strings.EqualFold(component, other)) {
				matched = false
				break
			}
		}
		if matched {
			if len(base.components) == len(directory.components) {
				return "."
			}
			return strings.Join(directory.components[len(base.components):], directory.separator)
		}
	}
	name := directory.components[len(directory.components)-1]
	if name == "" || name == "." || driveRoot.MatchString(name) {
		return "."
	}
	return name
}

// WorkingDirectoryName reduces every working directory in a normalized event
// to the folder's own name at the metadata level; one that names no folder
// (a filesystem root, an empty value) is dropped. It must run before
// PlaceEvent, while the path is still absolute, so that the project root
// yields its name rather than ".".
func WorkingDirectoryName(event map[string]any, level ContentLevel) map[string]any {
	if level != Metadata {
		return event
	}
	return nameWorkingDirectories(event).(map[string]any)
}

func nameWorkingDirectories(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			if directory, isText := child.(string); isText && workingDirectoryMembers[strings.ToLower(key)] {
				if name := folderName(directory); name != "" {
					out[key] = name
				}
				continue
			}
			out[key] = nameWorkingDirectories(child)
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = nameWorkingDirectories(child)
		}
		return out
	}
	return value
}

func folderName(directory string) string {
	if path, isPath := localPathOf(directory); isPath {
		directory = path
	}
	directory = strings.TrimRight(extendedPrefix.ReplaceAllString(strings.TrimSpace(directory), "$1"), `/\`)
	name := directory[strings.LastIndexAny(directory, `/\`)+1:]
	if name == "." || name == ".." || driveRoot.MatchString(name) {
		return ""
	}
	return name
}
