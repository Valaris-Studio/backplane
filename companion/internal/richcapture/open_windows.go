// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import "os"

func openSource(path string) (*os.File, error) { return os.Open(path) }
