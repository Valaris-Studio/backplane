// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package binding

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	ErrOriginInvalid  = errors.New("origin_invalid")
	ErrOriginScheme   = errors.New("origin_scheme")
	ErrOriginUserinfo = errors.New("origin_userinfo")
	ErrOriginOpaque   = errors.New("origin_opaque")
	ErrOriginPath     = errors.New("origin_path")
	ErrOriginQuery    = errors.New("origin_query")
	ErrOriginFragment = errors.New("origin_fragment")
	ErrOriginHost     = errors.New("origin_host")
	ErrOriginPort     = errors.New("origin_port")
)

// url.Parse has already decoded any percent-escape in the host, to "%" or a
// non-ASCII byte, so this grammar also refuses percent-encoded, IDN and
// trailing-dot hosts without an IDNA dependency.
var dnsHostName = regexp.MustCompile(`^[a-z0-9_-]+(\.[a-z0-9_-]+)*$`)

var allDigits = regexp.MustCompile(`^[0-9]+$`)

// NormalizeOrigin returns raw as scheme://host[:port], the spelling binding
// IDs compare by exact equality. Refusals are bare codes: the value can carry
// a password, and url.Parse errors quote it whole.
func NormalizeOrigin(raw string, allowLoopbackHTTP bool) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if strings.Contains(trimmed, "#") {
		return "", ErrOriginFragment
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", ErrOriginInvalid
	}
	switch {
	case parsed.User != nil:
		return "", ErrOriginUserinfo
	case parsed.Opaque != "":
		return "", ErrOriginOpaque
	case parsed.RawQuery != "" || parsed.ForceQuery:
		return "", ErrOriginQuery
	case parsed.Path != "" && parsed.Path != "/":
		return "", ErrOriginPath
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", ErrOriginScheme
	}
	host, address, err := canonicalHost(parsed)
	if err != nil {
		return "", err
	}
	defaultPort := 443
	if scheme == "http" {
		if !allowLoopbackHTTP || address == nil || !address.IsLoopback() {
			return "", ErrOriginScheme
		}
		defaultPort = 80
	}

	origin := scheme + "://" + host
	if strings.HasSuffix(parsed.Host, ":") {
		return "", ErrOriginPort
	}
	if parsed.Port() == "" {
		return origin, nil
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", ErrOriginPort
	}
	if port == defaultPort {
		return origin, nil
	}
	return origin + ":" + strconv.Itoa(port), nil
}

// canonicalHost spells the host as a lowercase DNS name, a dotted IPv4
// address or a bracketed compressed IPv6 address, and returns the address
// when the host is a literal one.
func canonicalHost(parsed *url.URL) (string, net.IP, error) {
	name := strings.ToLower(parsed.Hostname())
	if strings.HasPrefix(parsed.Host, "[") {
		address := net.ParseIP(name)
		if address == nil || address.To4() != nil {
			return "", nil, ErrOriginHost
		}
		return "[" + address.String() + "]", address, nil
	}
	if !dnsHostName.MatchString(name) {
		return "", nil, ErrOriginHost
	}
	// No top-level domain is all digits, so such a name is meant as an IPv4
	// address and must be spelled canonically ("127.1" or "3221225994" are
	// the same host as a dotted quad but a different binding).
	labels := strings.Split(name, ".")
	if allDigits.MatchString(labels[len(labels)-1]) {
		address := net.ParseIP(name)
		if address == nil || address.String() != name {
			return "", nil, ErrOriginHost
		}
		return name, address, nil
	}
	return name, nil, nil
}
