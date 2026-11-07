// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package credentials

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const tokenFileName = "device-token"

// nonBlockingBound turns an open that would hang on a FIFO into a failure.
const nonBlockingBound = 2 * time.Second

func sentinelToken() string    { return "bpc_" + strings.Repeat("Q", 43) }
func replacementToken() string { return "bpc_" + strings.Repeat("R", 43) }

func echoesAToken(message string) bool {
	return strings.Contains(message, strings.Repeat("Q", 8)) || strings.Contains(message, strings.Repeat("R", 8))
}

// ancestryFault names the first component of dir, walking up to /, that the
// token file's ancestor rules would refuse for an owner acceptOwner allows.
func ancestryFault(dir string, acceptOwner func(uint32) bool) string {
	for current := dir; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err.Error()
		}
		owner := info.Sys().(*syscall.Stat_t).Uid
		othersWrite := info.Mode().Perm()&0o022 != 0 && info.Mode()&os.ModeSticky == 0
		if !info.IsDir() || !acceptOwner(owner) || othersWrite {
			return fmt.Sprintf("%s (owner %d, mode %v)", current, owner, info.Mode())
		}
		if current == filepath.Dir(current) {
			return ""
		}
	}
}

func rootOrSelf(owner uint32) bool { return owner == 0 || int(owner) == os.Getuid() }
func rootOnly(owner uint32) bool   { return owner == 0 }

// privateDir is a fresh temp directory named without symlinks: macOS spells
// t.TempDir() through /var, a symlink to /private/var. A host whose temp
// directory already fails the ancestor rules is skipped, so every refusal
// below is caused by the case under test.
func privateDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if fault := ancestryFault(dir, rootOrSelf); fault != "" {
		t.Skipf("the temp directory fails the ancestor rules on this host: %s", fault)
	}
	return dir
}

func writeTokenFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func specFor(t *testing.T, path string) TokenFileSpec {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return TokenFileSpec{Path: path, UID: os.Getuid(), GID: int(info.Sys().(*syscall.Stat_t).Gid)}
}

func ownSpec(path string) TokenFileSpec {
	return TokenFileSpec{Path: path, UID: os.Getuid(), GID: os.Getgid()}
}

func withPath(spec TokenFileSpec, path string) TokenFileSpec {
	spec.Path = path
	return spec
}

func tokenFixture(t *testing.T, content string, mode os.FileMode) TokenFileSpec {
	t.Helper()
	path := filepath.Join(privateDir(t), tokenFileName)
	writeTokenFile(t, path, content, mode)
	return specFor(t, path)
}

func mustRead(t *testing.T, spec TokenFileSpec) (string, FileIdentity) {
	t.Helper()
	token, identity, err := ReadTokenFile(spec)
	if err != nil {
		t.Fatalf("control read refused: %v", err)
	}
	return token, identity
}

func statIdentity(t *testing.T, path string) FileIdentity {
	t.Helper()
	identity, err := StatTokenFile(path)
	if err != nil {
		t.Fatalf("stat %s: %v", filepath.Base(path), err)
	}
	return identity
}

func errorChain(err error) []error {
	var chain []error
	pending := []error{err}
	for len(pending) > 0 {
		current := pending[0]
		pending = pending[1:]
		if current == nil {
			continue
		}
		chain = append(chain, current)
		switch wrapper := current.(type) {
		case interface{ Unwrap() error }:
			pending = append(pending, wrapper.Unwrap())
		case interface{ Unwrap() []error }:
			pending = append(pending, wrapper.Unwrap()...)
		}
	}
	return chain
}

// unsafeCheck reads the Check of the innermost "credential_unsafe:<check>"
// error, whether UnsafeCredentialError is returned bare or wrapped.
func unsafeCheck(err error) string {
	check := ""
	for _, link := range errorChain(err) {
		if rest, found := strings.CutPrefix(link.Error(), "credential_unsafe:"); found {
			check = rest
		}
	}
	return check
}

func requireRefusal(t *testing.T, token string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("read accepted (a %d-byte token)", len(token))
	}
	if token != "" {
		t.Fatalf("a refused read returned %d token bytes", len(token))
	}
	if echoesAToken(err.Error()) {
		t.Fatal("the refusal carries token bytes")
	}
}

func refusedAs(t *testing.T, spec TokenFileSpec, check string) {
	t.Helper()
	token, _, err := ReadTokenFile(spec)
	requireRefusal(t, token, err)
	if !errors.Is(err, ErrCredentialUnsafe) || unsafeCheck(err) != check {
		t.Fatalf("refused with %v, want credential_unsafe:%s", err, check)
	}
}

func refusedAsMalformed(t *testing.T, spec TokenFileSpec) {
	t.Helper()
	token, _, err := ReadTokenFile(spec)
	requireRefusal(t, token, err)
	if !errors.Is(err, ErrCredentialMalformed) || errors.Is(err, ErrCredentialUnsafe) {
		t.Fatalf("refused with %v, want credential_malformed", err)
	}
}

func readWithin(t *testing.T, spec TokenFileSpec, bound time.Duration) (string, error) {
	t.Helper()
	type result struct {
		token string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		token, _, err := ReadTokenFile(spec)
		done <- result{token, err}
	}()
	select {
	case read := <-done:
		return read.token, read.err
	case <-time.After(bound):
		// Opening the write end releases a reader stuck opening a FIFO.
		if writer, err := os.OpenFile(spec.Path, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			writer.Close()
		}
		t.Fatalf("reading %s blocked for %v", filepath.Base(spec.Path), bound)
		return "", nil
	}
}

func installAfterTokenPathCheck(t *testing.T, hook func()) {
	t.Helper()
	afterTokenPathCheck = hook
	t.Cleanup(func() { afterTokenPathCheck = func() {} })
}

func TestReadTokenFile_AcceptsAnOwnerOnlyTokenWithOrWithoutOneNewline(t *testing.T) {
	for _, mode := range []os.FileMode{0o400, 0o600} {
		for _, newline := range []string{"", "\n"} {
			t.Run(fmt.Sprintf("%#o/newline=%t", mode, newline != ""), func(t *testing.T) {
				content := sentinelToken() + newline
				spec := tokenFixture(t, content, mode)
				token, identity := mustRead(t, spec)
				if token != sentinelToken() {
					t.Fatalf("read %d bytes, want the %d-byte token without its newline", len(token), len(sentinelToken()))
				}
				if identity.Size != int64(len(content)) || identity.UID != uint32(spec.UID) || identity.GID != uint32(spec.GID) {
					t.Fatalf("identity %+v does not describe the %d-byte file read", identity, len(content))
				}
				if stat := statIdentity(t, spec.Path); stat != identity {
					t.Fatalf("StatTokenFile %+v differs from the identity read %+v", stat, identity)
				}
			})
		}
	}
	t.Run("every body character", func(t *testing.T) {
		token := "bpc_" + strings.Repeat("aZ09_-", 7) + "x"
		if got, _ := mustRead(t, tokenFixture(t, token+"\n", 0o600)); got != token {
			t.Fatalf("read %q, want %q", got, token)
		}
	})
}

func TestReadTokenFile_RefusesAPathThatIsNotAbsoluteAndClean(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	dir := filepath.Dir(spec.Path)
	mustRead(t, spec)
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	for _, tc := range []struct{ name, path, check string }{
		{"relative", tokenFileName, "relative_path"},
		{"empty", "", "relative_path"},
		{"dot component", dir + "/./" + tokenFileName, "unclean_path"},
		{"double slash", dir + "//" + tokenFileName, "unclean_path"},
		{"dot-dot component", dir + "/sub/../" + tokenFileName, "unclean_path"},
		{"trailing slash", spec.Path + "/", "unclean_path"},
	} {
		t.Run(tc.name, func(t *testing.T) { refusedAs(t, withPath(spec, tc.path), tc.check) })
	}
}

func TestReadTokenFile_RefusesAPathWithANULByte(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	mustRead(t, spec)
	token, _, err := ReadTokenFile(withPath(spec, spec.Path+"\x00.bak"))
	requireRefusal(t, token, err)
	if !errors.Is(err, ErrCredentialUnsafe) || unsafeCheck(err) == "" {
		t.Fatalf("refused with %v, want a credential_unsafe check", err)
	}
}

// pathOfLength extends base with components of at most 200 bytes until the
// clean path is exactly length bytes long.
func pathOfLength(t *testing.T, base string, length int) string {
	t.Helper()
	path := base
	for len(path) < length {
		remaining := length - len(path)
		component := min(remaining-1, 200)
		if remaining-1-component == 1 {
			component--
		}
		path += "/" + strings.Repeat("b", component)
	}
	if len(path) != length || filepath.Clean(path) != path {
		t.Fatalf("built a %d-byte path, want a clean %d-byte one", len(path), length)
	}
	return path
}

func TestReadTokenFile_RefusesAPathLongerThan4096Bytes(t *testing.T) {
	base := filepath.Join(privateDir(t), "missing")
	_, _, err := ReadTokenFile(ownSpec(pathOfLength(t, base, 4096)))
	if !errors.Is(err, ErrCredentialMissing) {
		t.Fatalf("a 4096-byte path under a missing directory: %v, want credential_missing", err)
	}
	refusedAs(t, ownSpec(pathOfLength(t, base, 4097)), "path_too_long")
}

func TestReadTokenFile_RefusesAPathThatLooksLikeATokenWithoutEchoingIt(t *testing.T) {
	dir := privateDir(t)
	named := filepath.Join(dir, sentinelToken())
	writeTokenFile(t, named, sentinelToken(), 0o600)
	refusedAs(t, specFor(t, named), "path_looks_like_token")

	// A token pasted where the path belongs is also relative; either code
	// will do as long as the value is not repeated back.
	t.Chdir(dir)
	token, _, err := ReadTokenFile(ownSpec(sentinelToken()))
	requireRefusal(t, token, err)
	if check := unsafeCheck(err); !errors.Is(err, ErrCredentialUnsafe) || (check != "path_looks_like_token" && check != "relative_path") {
		t.Fatalf("refused with %v, want credential_unsafe:path_looks_like_token", err)
	}
}

func TestReadTokenFile_RefusesASymlinkAtThePath(t *testing.T) {
	dir := privateDir(t)
	realPath := filepath.Join(dir, "real-token")
	writeTokenFile(t, realPath, sentinelToken(), 0o600)
	spec := specFor(t, realPath)
	mustRead(t, spec)
	for _, tc := range []struct{ name, target string }{
		{"absolute", realPath},
		{"relative", "real-token"},
		{"dangling", filepath.Join(dir, "absent")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			link := filepath.Join(dir, tc.name+"-link")
			if err := os.Symlink(tc.target, link); err != nil {
				t.Fatal(err)
			}
			refusedAs(t, withPath(spec, link), "symlink")
		})
	}
}

func TestReadTokenFile_RefusesASymlinkedAncestor(t *testing.T) {
	dir := privateDir(t)
	realPath := filepath.Join(dir, "real", tokenFileName)
	if err := os.Mkdir(filepath.Dir(realPath), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTokenFile(t, realPath, sentinelToken(), 0o600)
	spec := specFor(t, realPath)
	mustRead(t, spec)
	if err := os.Symlink("real", filepath.Join(dir, "alias")); err != nil {
		t.Fatal(err)
	}
	refusedAs(t, withPath(spec, filepath.Join(dir, "alias", tokenFileName)), "symlink")
}

func TestReadTokenFile_RefusesTheTempDirSpelledThroughASymlink(t *testing.T) {
	spelled := t.TempDir()
	resolved, err := filepath.EvalSymlinks(spelled)
	if err != nil {
		t.Fatal(err)
	}
	if spelled == resolved {
		t.Skip("t.TempDir() has no symlinked component on this host (macOS spells it through /var)")
	}
	if fault := ancestryFault(resolved, rootOrSelf); fault != "" {
		t.Skipf("the temp directory fails the ancestor rules on this host: %s", fault)
	}
	path := filepath.Join(resolved, tokenFileName)
	writeTokenFile(t, path, sentinelToken(), 0o600)
	spec := specFor(t, path)
	mustRead(t, spec)
	refusedAs(t, withPath(spec, filepath.Join(spelled, tokenFileName)), "symlink")
}

func TestReadTokenFile_RefusesAnAncestorThatIsNotADirectory(t *testing.T) {
	plain := filepath.Join(privateDir(t), "plain")
	writeTokenFile(t, plain, sentinelToken(), 0o600)
	refusedAs(t, withPath(specFor(t, plain), filepath.Join(plain, tokenFileName)), "ancestor_not_directory")
}

func TestReadTokenFile_RefusesAnAncestorOthersCanWriteUnlessItIsSticky(t *testing.T) {
	for _, ancestor := range []string{"outer", "outer/inner"} {
		for _, tc := range []struct {
			mode    os.FileMode
			refused bool
		}{
			{0o777, true},
			{0o770, true},
			{0o707, true},
			{0o720, true},
			{0o702, true},
			{os.ModeSticky | 0o777, false},
			{os.ModeSticky | 0o770, false},
			{0o755, false},
			{0o711, false},
		} {
			t.Run(fmt.Sprintf("%s/%v", ancestor, tc.mode), func(t *testing.T) {
				dir := privateDir(t)
				path := filepath.Join(dir, "outer", "inner", tokenFileName)
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				writeTokenFile(t, path, sentinelToken(), 0o600)
				spec := specFor(t, path)
				mustRead(t, spec)
				if err := os.Chmod(filepath.Join(dir, ancestor), tc.mode); err != nil {
					t.Fatal(err)
				}
				if tc.refused {
					refusedAs(t, spec, "ancestor_writable")
				} else if token, _ := mustRead(t, spec); token != sentinelToken() {
					t.Fatalf("read %d bytes through a %v ancestor", len(token), tc.mode)
				}
			})
		}
	}
}

func TestReadTokenFile_RefusesAnAncestorOwnedByAnotherUser(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("as root every ancestor is owned by root, which the rule accepts")
	}
	spec := tokenFixture(t, sentinelToken(), 0o600)
	mustRead(t, spec)
	spec.UID = os.Getuid() + 1
	refusedAs(t, spec, "ancestor_owner")
}

// A root-owned sticky directory (/tmp) passes the ancestor rule for any
// expected owner, so only the file's own owner can be at fault.
func TestReadTokenFile_RefusesAFileOwnedByAnotherUser(t *testing.T) {
	shared, err := filepath.EvalSymlinks("/tmp")
	if err != nil {
		t.Skipf("no /tmp on this host: %v", err)
	}
	if fault := ancestryFault(shared, rootOnly); fault != "" {
		t.Skipf("/tmp is not a root-owned sticky directory here: %s", fault)
	}
	file, err := os.CreateTemp(shared, "backplane-token-owner-")
	if err != nil {
		t.Skipf("cannot create a file in %s: %v", shared, err)
	}
	t.Cleanup(func() { os.Remove(file.Name()) })
	_, writeErr := file.WriteString(sentinelToken())
	if closeErr := file.Close(); writeErr != nil || closeErr != nil {
		t.Fatal(writeErr, closeErr)
	}
	if err := os.Chmod(file.Name(), 0o600); err != nil {
		t.Fatal(err)
	}
	spec := specFor(t, file.Name())
	mustRead(t, spec)
	spec.UID = os.Getuid() + 1
	refusedAs(t, spec, "owner")
}

func TestReadTokenFile_RefusesAFileOfAnotherGroup(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	mustRead(t, spec)
	spec.GID++
	refusedAs(t, spec, "group")
}

func TestReadTokenFile_RefusesAFileKnownByASecondName(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	mustRead(t, spec)
	if err := os.Link(spec.Path, filepath.Join(filepath.Dir(spec.Path), "second-name")); err != nil {
		t.Fatal(err)
	}
	refusedAs(t, spec, "hardlink")
}

func TestReadTokenFile_RefusesAnyModeButOwnerReadOrReadWrite(t *testing.T) {
	const specialBits = os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky
	for _, mode := range []os.FileMode{
		0o640, 0o644, 0o700, 0o604, 0o500, 0o660, 0o606, 0o620, 0o602, 0o440, 0o404,
		os.ModeSetuid | 0o600, os.ModeSetuid | 0o400, os.ModeSetgid | 0o600, os.ModeSticky | 0o600,
	} {
		t.Run(mode.String(), func(t *testing.T) {
			spec := tokenFixture(t, sentinelToken(), 0o600)
			mustRead(t, spec)
			if err := os.Chmod(spec.Path, mode); err != nil {
				t.Skipf("this host refuses mode %v on a file: %v", mode, err)
			}
			if info, err := os.Lstat(spec.Path); err != nil || info.Mode()&specialBits != mode {
				t.Skipf("this filesystem does not keep mode %v", mode)
			}
			refusedAs(t, spec, "mode")
		})
	}
}

func TestReadTokenFile_RefusesAFIFOWithoutBlocking(t *testing.T) {
	path := filepath.Join(privateDir(t), tokenFileName)
	if err := unix.Mkfifo(path, 0o600); err != nil {
		t.Skipf("no FIFO on this filesystem: %v", err)
	}
	token, err := readWithin(t, specFor(t, path), nonBlockingBound)
	requireRefusal(t, token, err)
	if !errors.Is(err, ErrCredentialUnsafe) || unsafeCheck(err) != "not_regular" {
		t.Fatalf("refused with %v, want credential_unsafe:not_regular", err)
	}
}

func TestReadTokenFile_RefusesADirectory(t *testing.T) {
	path := filepath.Join(privateDir(t), tokenFileName)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	refusedAs(t, specFor(t, path), "not_regular")
}

func TestReadTokenFile_RefusesAFileThatIsNotExactlyATokenLong(t *testing.T) {
	for _, tc := range []struct{ name, content string }{
		{"empty", ""},
		{"46 bytes", "bpc_" + strings.Repeat("Q", 42)},
		{"49 bytes", "bpc_" + strings.Repeat("Q", 45)},
		{"token and CRLF", sentinelToken() + "\r\n"},
		{"token and two newlines", sentinelToken() + "\n\n"},
		{"1 MiB", "bpc_" + strings.Repeat("Q", 1<<20-4)},
	} {
		t.Run(tc.name, func(t *testing.T) { refusedAs(t, tokenFixture(t, tc.content, 0o600), "size") })
	}
}

func TestReadTokenFile_RefusesMalformedContentOfATokensLength(t *testing.T) {
	for _, tc := range []struct{ name, content string }{
		{"trailing CR", sentinelToken() + "\r"},
		{"CRLF", "bpc_" + strings.Repeat("Q", 42) + "\r\n"},
		{"byte order mark", "\ufeff" + "bpc_" + strings.Repeat("Q", 40)},
		{"two lines", "bpc_" + strings.Repeat("Q", 20) + "\n" + strings.Repeat("Q", 22) + "\n"},
		{"leading newline", "\n" + sentinelToken()},
		{"leading space", " " + sentinelToken()},
		{"trailing space", sentinelToken() + " "},
		{"trailing tab", sentinelToken() + "\t"},
		{"non-ASCII", "bpc_" + strings.Repeat("Q", 41) + "\u00e9"},
		{"NUL byte", "bpc_" + strings.Repeat("Q", 42) + "\x00"},
		{"wrong prefix", "bpx_" + strings.Repeat("Q", 43)},
		{"uppercase prefix", "BPC_" + strings.Repeat("Q", 43)},
		{"API key prefix", "vlr_" + strings.Repeat("Q", 43)},
		{"no separator", "bpc" + strings.Repeat("Q", 44)},
		{"42 body characters", "bpc_" + strings.Repeat("Q", 42) + "\n"},
		{"44 body characters", "bpc_" + strings.Repeat("Q", 44)},
		{"padding character", "bpc_" + strings.Repeat("Q", 42) + "="},
		{"dot", "bpc_" + strings.Repeat("Q", 42) + "."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if size := len(tc.content); size != 47 && size != 48 {
				t.Fatalf("case is %d bytes; the content rule is only reached at 47 or 48", size)
			}
			refusedAsMalformed(t, tokenFixture(t, tc.content, 0o600))
		})
	}
}

func TestReadTokenFile_AMissingFileOrAncestorIsCredentialMissing(t *testing.T) {
	dir := privateDir(t)
	for _, path := range []string{filepath.Join(dir, tokenFileName), filepath.Join(dir, "absent", tokenFileName)} {
		token, _, err := ReadTokenFile(ownSpec(path))
		requireRefusal(t, token, err)
		if !errors.Is(err, ErrCredentialMissing) || errors.Is(err, ErrCredentialUnsafe) {
			t.Errorf("%s: %v, want credential_missing", strings.TrimPrefix(path, dir), err)
		}
	}
}

func TestReadTokenFile_RefusesWhatIsSwappedInAfterThePathCheck(t *testing.T) {
	for _, tc := range []struct {
		name, check string
		swap        func(path string) error
	}{
		{"symlink", "symlink", func(path string) error {
			other := path + ".other"
			if err := os.WriteFile(other, []byte(replacementToken()), 0o600); err != nil {
				return err
			}
			if err := os.Symlink(other, path+".link"); err != nil {
				return err
			}
			return os.Rename(path+".link", path)
		}},
		{"second name", "hardlink", func(path string) error {
			other := path + ".other"
			if err := os.WriteFile(other, []byte(replacementToken()), 0o600); err != nil {
				return err
			}
			if err := os.Link(other, path+".next"); err != nil {
				return err
			}
			return os.Rename(path+".next", path)
		}},
		{"FIFO", "not_regular", func(path string) error {
			if err := os.Remove(path); err != nil {
				return err
			}
			return unix.Mkfifo(path, 0o600)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spec := tokenFixture(t, sentinelToken(), 0o600)
			mustRead(t, spec)
			var swapped atomic.Bool
			var swapErr error
			installAfterTokenPathCheck(t, func() {
				if swapped.CompareAndSwap(false, true) {
					swapErr = tc.swap(spec.Path)
				}
			})
			token, err := readWithin(t, spec, nonBlockingBound)
			if !swapped.Load() || swapErr != nil {
				t.Fatalf("the swap did not happen between the path check and the open: ran=%t err=%v", swapped.Load(), swapErr)
			}
			requireRefusal(t, token, err)
			if !errors.Is(err, ErrCredentialUnsafe) || unsafeCheck(err) != tc.check {
				t.Fatalf("refused with %v, want credential_unsafe:%s", err, tc.check)
			}
		})
	}
}

func TestReadTokenFile_AnAncestorSwappedAfterThePathCheckNeverYieldsThePlantedToken(t *testing.T) {
	dir := privateDir(t)
	path := filepath.Join(dir, "tokens", tokenFileName)
	planted := filepath.Join(dir, "planted", tokenFileName)
	for _, file := range []struct{ path, token string }{{path, sentinelToken()}, {planted, replacementToken()}} {
		if err := os.Mkdir(filepath.Dir(file.path), 0o700); err != nil {
			t.Fatal(err)
		}
		writeTokenFile(t, file.path, file.token, 0o600)
	}
	spec := specFor(t, path)
	mustRead(t, spec)
	var swapped atomic.Bool
	var swapErr error
	installAfterTokenPathCheck(t, func() {
		if swapped.CompareAndSwap(false, true) {
			if swapErr = os.Rename(filepath.Join(dir, "tokens"), filepath.Join(dir, "moved")); swapErr == nil {
				swapErr = os.Symlink("planted", filepath.Join(dir, "tokens"))
			}
		}
	})
	token, _, err := ReadTokenFile(spec)
	if !swapped.Load() || swapErr != nil {
		t.Fatalf("the swap did not happen between the path check and the open: ran=%t err=%v", swapped.Load(), swapErr)
	}
	if err != nil {
		requireRefusal(t, token, err)
		return
	}
	if token != sentinelToken() {
		t.Fatal("the read followed a directory swapped in after the path check to a planted token")
	}
}

// The writer keeps the token's bytes but flips the file between 47 and 48
// bytes in place, so every read races a size change; a read must notice
// rather than trust a size taken before the bytes were read.
func TestReadTokenFile_AFileRewrittenWhileReadIsRefusedAsChangedDuringRead(t *testing.T) {
	if runtime.GOMAXPROCS(0) < 2 {
		t.Skip("needs a second thread to rewrite the file while it is read")
	}
	token := sentinelToken()
	spec := tokenFixture(t, token, 0o600)
	mustRead(t, spec)
	writer, err := os.OpenFile(spec.Path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	var stop atomic.Bool
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for !stop.Load() {
			writer.WriteAt([]byte(token), 0)
			writer.WriteAt([]byte("\n"), int64(len(token)))
			writer.Truncate(int64(len(token)))
		}
	}()
	defer func() {
		stop.Store(true)
		<-stopped
	}()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		read, _, err := ReadTokenFile(spec)
		if err == nil {
			if read != token {
				t.Fatalf("a read during the rewrite returned %d bytes that were never the token", len(read))
			}
			continue
		}
		requireRefusal(t, read, err)
		if unsafeCheck(err) == "changed_during_read" {
			return
		}
		if !errors.Is(err, ErrCredentialUnsafe) && !errors.Is(err, ErrCredentialMalformed) {
			t.Fatalf("a read during the rewrite failed with %v", err)
		}
	}
	t.Fatal("no read noticed the file changing under it (want credential_unsafe:changed_during_read)")
}

func TestStatTokenFile_ChangesWhenTheFileIsReplacedChmoddedOrTouched(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	_, read := mustRead(t, spec)
	identity := statIdentity(t, spec.Path)
	if identity != read {
		t.Fatalf("StatTokenFile %+v differs from the identity read %+v", identity, read)
	}
	if again := statIdentity(t, spec.Path); again != identity {
		t.Fatal("an untouched file changed identity")
	}

	next := filepath.Join(filepath.Dir(spec.Path), ".next-token")
	writeTokenFile(t, next, replacementToken(), 0o600)
	if err := os.Rename(next, spec.Path); err != nil {
		t.Fatal(err)
	}
	replaced := statIdentity(t, spec.Path)
	if replaced == identity {
		t.Fatal("a file renamed over the path kept the old identity")
	}
	if token, read := mustRead(t, spec); token != replacementToken() || read != replaced {
		t.Fatalf("after the replace: read %d bytes with identity %+v, want the new token with %+v", len(token), read, replaced)
	}

	if err := os.Chmod(spec.Path, 0o400); err != nil {
		t.Fatal(err)
	}
	chmodded := statIdentity(t, spec.Path)
	if chmodded == replaced {
		t.Fatal("a chmod kept the identity")
	}

	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(spec.Path, later, later); err != nil {
		t.Fatal(err)
	}
	if touched := statIdentity(t, spec.Path); touched == chmodded {
		t.Fatal("a touch kept the identity")
	}
}

func TestStatTokenFile_DoesNotFollowASymlink(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	target := statIdentity(t, spec.Path)
	link := filepath.Join(filepath.Dir(spec.Path), "link")
	if err := os.Symlink(spec.Path, link); err != nil {
		t.Fatal(err)
	}
	identity, err := StatTokenFile(link)
	if err != nil {
		return
	}
	if identity == target {
		t.Fatal("StatTokenFile followed the symlink to its target")
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(spec.Path, later, later); err != nil {
		t.Fatal(err)
	}
	if again, err := StatTokenFile(link); err != nil || again != identity {
		t.Fatalf("touching the target changed what StatTokenFile reports for the link: %v", err)
	}
}

func TestStatTokenFile_AMissingFileIsCredentialMissing(t *testing.T) {
	if _, err := StatTokenFile(filepath.Join(privateDir(t), tokenFileName)); !errors.Is(err, ErrCredentialMissing) {
		t.Fatalf("stat of a missing file: %v, want credential_missing", err)
	}
}

const (
	fileInstallation  = "7a1c0de5-0000-4000-8000-000000000001"
	otherInstallation = "7a1c0de5-0000-4000-8000-000000000002"
)

func TestTokenFileStore_LoadsTheTokenOnlyForItsInstallation(t *testing.T) {
	spec := tokenFixture(t, sentinelToken()+"\n", 0o400)
	var store Store = &TokenFileStore{Spec: spec, InstallationID: fileInstallation}
	if token, err := store.Load(fileInstallation); err != nil || token != sentinelToken() {
		t.Fatalf("load own installation: %d bytes, %v", len(token), err)
	}
	for _, account := range []string{otherInstallation, AgentKeyAccount(fileInstallation)} {
		if token, err := store.Load(account); !errors.Is(err, ErrNotFound) || token != "" {
			t.Errorf("load %q: %d bytes, %v; want device_credential_missing", account, len(token), err)
		}
	}
}

func TestTokenFileStore_LoadReportsWhyTheFileWasRefused(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	store := &TokenFileStore{Spec: spec, InstallationID: fileInstallation}
	if err := os.Chmod(spec.Path, 0o644); err != nil {
		t.Fatal(err)
	}
	token, err := store.Load(fileInstallation)
	requireRefusal(t, token, err)
	if !errors.Is(err, ErrCredentialUnsafe) || errors.Is(err, ErrNotFound) {
		t.Errorf("an unsafe file: %v, want credential_unsafe and not device_credential_missing", err)
	}
	if err := os.Remove(spec.Path); err != nil {
		t.Fatal(err)
	}
	token, err = store.Load(fileInstallation)
	requireRefusal(t, token, err)
	if !errors.Is(err, ErrCredentialMissing) || errors.Is(err, ErrNotFound) {
		t.Errorf("a removed file: %v, want credential_missing and not device_credential_missing", err)
	}
}

func TestTokenFileStore_NeverWritesOrDeletesTheFile(t *testing.T) {
	spec := tokenFixture(t, sentinelToken(), 0o600)
	store := &TokenFileStore{Spec: spec, InstallationID: fileInstallation}
	before := statIdentity(t, spec.Path)
	for _, account := range []string{fileInstallation, otherInstallation} {
		if err := store.Save(account, replacementToken()); !errors.Is(err, ErrReadOnlyCredential) || echoesAToken(err.Error()) {
			t.Errorf("save %q: %v, want credential_read_only without the token", account, err)
		}
		if err := store.Delete(account); !errors.Is(err, ErrReadOnlyCredential) {
			t.Errorf("delete %q: %v, want credential_read_only", account, err)
		}
	}
	if after := statIdentity(t, spec.Path); after != before {
		t.Fatal("the token file changed")
	}
	if token, _ := mustRead(t, spec); token != sentinelToken() {
		t.Fatal("the token file no longer holds its token")
	}
}
