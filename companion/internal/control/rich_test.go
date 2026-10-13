// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
)

// richMapping is a rich mapping create for a root that is absolute here.
func richMapping(t *testing.T) string {
	body, err := json.Marshal(map[string]string{"workspace_id": "w1", "board_id": "b1", "root_path": contracttest.HostPath("/src/app"), "content_level": "rich"})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestMappings_AcceptTheRichLevel(t *testing.T) {
	server, fake := proxyServer(t)
	reply := server.do(t, "POST", "/v1/mappings", richMapping(t))
	if reply.status != 200 {
		t.Fatalf("create: %d %s", reply.status, reply.body)
	}
	if _, body := fake.lastRequest(); body["content_level"] != "rich" {
		t.Fatalf("upstream saw %v", body)
	}
	if reply := server.do(t, "PATCH", "/v1/mappings/m1", `{"content_level":"rich"}`); reply.status != 200 {
		t.Fatalf("update: %d %s", reply.status, reply.body)
	}
}

// A server with rich capture switched off refuses a rich mapping; the
// desktop meets the control API's conflict, the server's code in its detail.
func TestMappings_ARichCaptureUnavailableRefusalKeepsItsCode(t *testing.T) {
	example := contracttest.WireExample(t, "error-rich-capture-unavailable-mapping.json")
	var envelope map[string]any
	json.Unmarshal(example.Body, &envelope)
	for _, write := range []struct{ method, path, body string }{
		{"POST", "/v1/mappings", richMapping(t)},
		{"PATCH", "/v1/mappings/m1", `{"content_level":"rich"}`},
	} {
		server, fake := proxyServer(t)
		fake.fail, fake.failBody = example.HTTP.Status, envelope
		reply := server.do(t, write.method, write.path, write.body)
		if reply.status != http.StatusConflict || reply.errorCode(t) != CodeConflict {
			t.Fatalf("%s: %d %s", write.method, reply.status, reply.body)
		}
		detail := reply.json(t)["error"].(map[string]any)["detail"].(map[string]any)
		if detail["status"] != float64(409) || detail["error_code"] != "rich_capture_unavailable" {
			t.Fatalf("%s: detail %v", write.method, detail)
		}
	}
}
