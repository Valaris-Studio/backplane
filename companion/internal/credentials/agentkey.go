// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

// agentKeySuffix separates the agents' API key from the device token in the
// same keyring service; an installation id never contains a slash.
const agentKeySuffix = "/agents"

// AgentKeyAccount is the keyring account of the API key agents on this
// device use through `backplane-companion mcp`.
func AgentKeyAccount(installationID string) string { return installationID + agentKeySuffix }
