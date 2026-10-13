// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package credentials

import (
	"errors"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestAgentKeyAccount_KeepsDeviceTokenSeparate(t *testing.T) {
	keyring.MockInit()
	store := Keyring{}
	const installation = "7a1c0de5-0000-4000-8000-000000000001"
	if err := store.Save(installation, "bpc_device_token"); err != nil {
		t.Fatal(err)
	}
	if AgentKeyAccount(installation) == installation {
		t.Fatal("the agent key shares the device token's account")
	}
	if err := store.Save(AgentKeyAccount(installation), "vlr_agent_key"); err != nil {
		t.Fatal(err)
	}
	if token, _ := store.Load(installation); token != "bpc_device_token" {
		t.Fatalf("device token overwritten: %q", token)
	}
	if err := store.Delete(AgentKeyAccount(installation)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(AgentKeyAccount(installation)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("agent key survived delete: %v", err)
	}
	if token, _ := store.Load(installation); token != "bpc_device_token" {
		t.Fatal("deleting the agent key deleted the device token")
	}
}
