.PHONY: build test lint discover doctor clean

BINARY := backplane-runner
BUILD_DIR := ./bin

VERSION ?= dev
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -ldflags "-X github.com/Valaris-Studio/backplane/runner/internal/version.Version=$(VERSION) -X github.com/Valaris-Studio/backplane/runner/internal/version.GitCommit=$(GIT_COMMIT) -X github.com/Valaris-Studio/backplane/runner/internal/version.BuildTime=$(BUILD_TIME)"

build:
	go build $(LDFLAGS) -o $(BUILD_DIR)/$(BINARY) ./cmd/backplane-runner/

# Out-of-tree: this suite drives real git (incl. reset --hard), and an in-repo
# run once rewound main and destroyed 25 commits.
test:
	../scripts/go-test-safe.sh -v

lint:
	go vet ./...

discover: build
	$(BUILD_DIR)/$(BINARY) --discover --config configs/runner.yaml

doctor: build
	$(BUILD_DIR)/$(BINARY) --doctor --config configs/runner.yaml

clean:
	rm -rf $(BUILD_DIR)
