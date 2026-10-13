// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import (
	"errors"
	"strings"
)

// Reasons an OS credential store is unavailable, for the error detail; the
// error code stays secure_credential_store_unavailable.
const (
	ReasonSecretServiceMissing = "secret_service_missing"
	ReasonSessionBusMissing    = "session_bus_missing"
	ReasonCollectionLocked     = "collection_locked"
)

// unavailableReasonMarkers are matched against text because Keyring wraps
// the backend error with %v, so its D-Bus type does not survive. Each marker
// is the message go-keyring or godbus returns (dbus-daemon and dbus-broker
// word a missing service differently).
var unavailableReasonMarkers = []struct{ marker, reason string }{
	{"org.freedesktop.secrets was not provided", ReasonSecretServiceMissing},
	{"The name is not activatable", ReasonSecretServiceMissing},
	{"couldn't determine address of session bus", ReasonSessionBusMissing},
	{`"dbus-launch"`, ReasonSessionBusMissing},
	{"failed to unlock correct collection", ReasonCollectionLocked},
	{"org.freedesktop.Secret.Error.IsLocked", ReasonCollectionLocked},
}

// UnavailableReason names why the store refused, or "" when err is not
// ErrUnavailable or its cause is not one the companion can name.
func UnavailableReason(err error) string {
	if !errors.Is(err, ErrUnavailable) {
		return ""
	}
	for _, known := range unavailableReasonMarkers {
		if strings.Contains(err.Error(), known.marker) {
			return known.reason
		}
	}
	return ""
}
