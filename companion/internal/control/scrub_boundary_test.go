// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import "testing"

func TestScrub_HomeInsideAnotherPathIsKept(t *testing.T) {
	for _, text := range []string{`/other-root/var/x`, `C:\data\home\jane\x`, `rel/home/jane`, `./home/jane`} {
		homes := []string{"/var", `\home\jane`, "/home/jane"}
		if got := string(Scrub([]byte(text), homes, false)); got != text {
			t.Fatalf("%s is not under home, got %s", text, got)
		}
	}
}

func TestScrub_HomeAfterANonPathCharacterIsScrubbed(t *testing.T) {
	homes := homeSpellings("/home/jane")
	cases := map[string]string{
		`/home/jane/x`:                            `~/x`,
		`"/home/jane/x"`:                          `"~/x"`,
		`'/home/jane'`:                            `'~'`,
		`--dir=/home/jane/x`:                      `--dir=~/x`,
		`PATH=/home/jane/bin:/home/jane/go`:      `PATH=~/bin:~/go`,
		`(/home/jane) [/home/jane]`:              `(~) [~]`,
		`{"a":"\/home\/jane\/x"}`:                 `{"a":"~\/x"}`,
		`{"m":"line\n/home/jane/x\t/home/jane"}`: `{"m":"line\n~/x\t~"}`,
		`file:///home/jane/x`:                     `file://~/x`,
		`{"u":"file:\/\/\/home\/jane\/x"}`:        `{"u":"file:\/\/~\/x"}`,
	}
	for text, want := range cases {
		if got := string(Scrub([]byte(text), homes, false)); got != want {
			t.Fatalf("Scrub(%s) = %s, want %s", text, got, want)
		}
	}
}

func TestScrub_WindowsHomeInEscapedAndQuotedStrings(t *testing.T) {
	homes := homeSpellings(`/home/jane`)
	homes = append(homes, `C:\home\jane`, `C:\\home\\jane`, "C:/home/jane")
	got := string(Scrub([]byte(`{"p":"C:\\home\\jane\\x","q":"C:/home/jane/y"} 'C:\home\jane'`), homes, false))
	if got != `{"p":"~\\x","q":"~/y"} '~'` {
		t.Fatalf("windows scrub: %s", got)
	}
}

func TestScrub_PercentEncodedHome(t *testing.T) {
	homes := homeSpellings("/home/jane")
	cases := map[string]string{
		`?path=%2Fhome%2Fjane%2Fcode`:     `?path=~%2Fcode`,
		`?path=%2fhome%2fjane%2fcode`:     `?path=~%2fcode`,
		`file%3A%2F%2F%2Fhome%2Fjane%2Fx`: `file%3A%2F%2F~%2Fx`,
		`x%2F/home/jane/y`:                `x%2F~/y`,
		`?path=%2Fhome%2Fjanet`:           `?path=%2Fhome%2Fjanet`,
		`?path=%2Fother%2Fhome%2Fjane`:    `?path=%2Fother%2Fhome%2Fjane`,
	}
	for text, want := range cases {
		if got := string(Scrub([]byte(text), homes, false)); got != want {
			t.Fatalf("Scrub(%s) = %s, want %s", text, got, want)
		}
	}
}

func TestScrub_BackToBackHomes(t *testing.T) {
	homes := homeSpellings("/home/jane")
	cases := map[string]string{
		`/home/jane/home/jane/data`: `~~/data`,
		`"/home/jane/home/jane"`:    `"~~"`,
		`/home/jane/x/home/jane`:    `~/x/home/jane`,
	}
	for text, want := range cases {
		if got := string(Scrub([]byte(text), homes, false)); got != want {
			t.Fatalf("Scrub(%s) = %s, want %s", text, got, want)
		}
	}
}

func TestScrub_EncodedDriveColonIsRedacted(t *testing.T) {
	homes := encodedSpellings([]string{`C:\home\jane`}, '\\')
	cases := map[string]string{
		`file:///C%3A/home/jane/x`:                   `file:///~/x`,
		`?path=C%3A%2Fhome%2Fjane%2Fcode`:            `?path=~%2Fcode`,
		`?path=C%3a%2fhome%2fjane%2fcode`:            `?path=~%2fcode`,
		`file%3A%2F%2F%2FC%3A%2Fhome%2Fjane%2Fx`:     `file%3A%2F%2F%2F~%2Fx`,
		`?p=C%3A%5Chome%5Cjane%5Cx`:                  `?p=~%5Cx`,
		`{"p":"C:\\home\\jane\\x","q":"C:/home/j"}`: `{"p":"~\\x","q":"C:/home/j"}`,
	}
	for text, want := range cases {
		if got := string(Scrub([]byte(text), homes, false)); got != want {
			t.Fatalf("Scrub(%s) = %s, want %s", text, got, want)
		}
	}
}

func TestScrub_EncodedDriveColonKeepsOtherPaths(t *testing.T) {
	homes := encodedSpellings([]string{`C:\home\jane`}, '\\')
	for _, text := range []string{
		`?path=C%3A%2Fhome%2Fjanet`,
		`?path=D%3A%2Fhome%2Fjane`,
		`?p=C%3A%5Chome%5Cjane.old`,
	} {
		if got := string(Scrub([]byte(text), homes, false)); got != text {
			t.Fatalf("%s is not home, got %s", text, got)
		}
	}
}

func TestScrub_EncodedDriveColonInAnyCaseOnACaseInsensitiveHome(t *testing.T) {
	homes := encodedSpellings([]string{`C:\home\jane`}, '\\')
	if got := string(Scrub([]byte(`?path=c%3a%2fHOME%2fJANE%2fx`), homes, true)); got != `?path=~%2fx` {
		t.Fatalf("case-insensitive encoded home: %s", got)
	}
}

func TestScrub_DoubleEncodedHomeIsRedacted(t *testing.T) {
	homes := encodedSpellings([]string{`C:\home\jane`}, '\\')
	cases := map[string]string{
		`?p=C%253A%252Fhome%252Fjane%252Fx`:                `?p=~%252Fx`,
		`?p=C%253a%252fhome%252fjane`:                      `?p=~`,
		`?p=C%253A%255Chome%255Cjane%255Cx`:                `?p=~%255Cx`,
		`?p=C%3A%252Fhome%252Fjane`:                        `?p=~`,
		`?p=C%253A%2Fhome%2Fjane`:                          `?p=~`,
		`?p=C%253A/home/jane/x`:                            `?p=~/x`,
		`file%253A%252F%252F%252FC%253A%252Fhome%252Fjane`: `file%253A%252F%252F%252F~`,
	}
	for text, want := range cases {
		if got := string(Scrub([]byte(text), homes, false)); got != want {
			t.Fatalf("Scrub(%s) = %s, want %s", text, got, want)
		}
	}
	unixHomes := encodedSpellings([]string{"/home/jane"}, '/')
	if got := string(Scrub([]byte(`?p=%252Fhome%252Fjane%252Fx`), unixHomes, false)); got != `?p=~%252Fx` {
		t.Fatalf("double-encoded unix home: %s", got)
	}
}

func TestScrub_UnrelatedDoubleEncodingIsKept(t *testing.T) {
	homes := encodedSpellings([]string{`C:\home\jane`}, '\\')
	for _, text := range []string{
		`?q=100%25%20off`,
		`?p=C%253A%252Fhome%252Fjanet`,
		`?p=D%253A%252Fhome%252Fjane`,
		`?p=%2525`,
	} {
		if got := string(Scrub([]byte(text), homes, false)); got != text {
			t.Fatalf("%s is not home, got %s", text, got)
		}
	}
}
