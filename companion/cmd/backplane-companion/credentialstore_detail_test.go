// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
)

func TestDescribeError_CredentialStoreUnavailableCarriesTheReason(t *testing.T) {
	err := fmt.Errorf("%w: %v", credentials.ErrUnavailable, errors.New("The name org.freedesktop.secrets was not provided by any .service files"))
	described := (&controlBackend{}).DescribeError(err, "en")
	if described == nil || described.Code != "secure_credential_store_unavailable" || described.Status != http.StatusServiceUnavailable {
		t.Fatalf("described: %+v", described)
	}
	want := map[string]any{"reason": credentials.ReasonSecretServiceMissing}
	if !reflect.DeepEqual(described.Detail, want) {
		t.Fatalf("detail %#v, want %#v", described.Detail, want)
	}
}

func TestDescribeError_UnclassifiedCredentialStoreFailureHasNoDetail(t *testing.T) {
	err := fmt.Errorf("%w: %v", credentials.ErrUnavailable, errors.New("User interaction is not allowed."))
	described := (&controlBackend{}).DescribeError(err, "en")
	if described == nil || described.Code != "secure_credential_store_unavailable" || described.Detail != nil {
		t.Fatalf("described: %+v", described)
	}
}
