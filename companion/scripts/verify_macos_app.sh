#!/usr/bin/env bash
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: MIT
#
# Checks a built Backplane Companion.app (and its DMG): signatures inside out,
# entitlements per binary, hardened runtime, Gatekeeper, stapled tickets,
# LSUIElement, universal executables, that the companion finds its Beacon
# artifacts, and an x86_64 smoke of every executable that has a non-GUI mode.
#
#   scripts/verify_macos_app.sh "dist/Backplane Companion.app" [dist/app.dmg] [--expect-notarized]
#
# Without --expect-notarized, Gatekeeper and stapler results are reported but
# not failed: an unnotarized build is expected to be rejected.
#
# Exit status: 0 all checks passed, 1 a check failed, 2 usage, 3 nothing failed
# but the x86_64 smoke was SKIPPED (Apple silicon without Rosetta 2).
set -uo pipefail

usage() { echo "usage: $0 <app> [<dmg>] [--expect-notarized]" >&2; exit 2; }

app="" dmg="" expect_notarized=0
for argument in "$@"; do
  case "$argument" in
    --expect-notarized) expect_notarized=1 ;;
    -*) usage ;;
    *) if [[ -z "$app" ]]; then app=$argument; elif [[ -z "$dmg" ]]; then dmg=$argument; else usage; fi ;;
  esac
done
[[ -n "$app" ]] || usage

failures=0 skipped=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
info() { printf 'INFO  %s\n' "$1"; }
skip() { printf 'SKIP  %s\n' "$1"; skipped=$((skipped + 1)); }
indent() { sed 's/^/      /'; }

contents="$app/Contents"
main_executable="$contents/MacOS/backplane-companion-desktop"
companion="$contents/MacOS/backplane-companion"
beacon="$contents/Resources/beacon"

if [[ ! -d "$contents" ]]; then
  fail "no app bundle at $app"
  exit 1
fi

# --- signatures -------------------------------------------------------------
if output=$(codesign --verify --deep --strict --verbose=2 "$app" 2>&1); then
  pass "codesign --verify --deep --strict"
else
  fail "codesign --verify --deep --strict"
fi
printf '%s\n' "$output" | indent

entitlement_keys() {
  # Prints one entitlement key per line; nothing when the binary has none.
  codesign -d --entitlements - --xml "$1" 2>/dev/null | /usr/bin/python3 -c 'import plistlib, sys
data = sys.stdin.buffer.read().strip()
for key in sorted(plistlib.loads(data) if data else {}): print(key)'
}

check_signed_code() {
  local label=$1 path=$2 wanted_entitlements=$3
  if [[ ! -f "$path" ]]; then
    fail "$label missing ($path)"
    return
  fi
  local details
  details=$(codesign -dvv "$path" 2>&1)
  if grep -q 'flags=.*runtime' <<<"$details"; then
    pass "$label: hardened runtime"
  else
    fail "$label: hardened runtime"
  fi
  grep -E '^(Authority|TeamIdentifier|Timestamp|Signature)=' <<<"$details" | indent
  local entitlements
  entitlements=$(entitlement_keys "$path" | paste -sd, -)
  echo "      entitlements: ${entitlements:-<none>}"
  if [[ "$entitlements" == "$wanted_entitlements" ]]; then
    pass "$label: entitlements are exactly [${wanted_entitlements:-none}]"
  else
    fail "$label: entitlements [${entitlements:-none}], want [${wanted_entitlements:-none}]"
  fi
}

check_signed_code "app executable" "$main_executable" "com.apple.security.cs.allow-jit"
check_signed_code "nested companion" "$companion" ""
check_signed_code "beacon-hooks" "$beacon/beacon-hooks" ""
check_signed_code "beacon-otelcol" "$beacon/beacon-otelcol" ""

# --- Gatekeeper and tickets -------------------------------------------------
gatekeeper() {
  local label=$1; shift
  if output=$("$@" 2>&1); then
    pass "$label"
  elif (( expect_notarized )); then
    fail "$label"
  else
    info "$label rejected (expected without notarization)"
  fi
  printf '%s\n' "$output" | indent
}

gatekeeper "spctl -a -t exec (app)" spctl -a -t exec -vv "$app"
gatekeeper "stapler validate (app)" xcrun stapler validate "$app"
if [[ -n "$dmg" ]]; then
  if output=$(hdiutil verify "$dmg" 2>&1); then pass "hdiutil verify (dmg)"; else fail "hdiutil verify (dmg)"; fi
  printf '%s\n' "$output" | tail -1 | indent
  gatekeeper "codesign --verify (dmg)" codesign --verify --strict --verbose=2 "$dmg"
  gatekeeper "spctl -a -t open (dmg)" spctl -a -t open --context context:primary-signature -vv "$dmg"
  gatekeeper "stapler validate (dmg)" xcrun stapler validate "$dmg"
fi

# --- bundle layout ----------------------------------------------------------
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$contents/Info.plist" 2>/dev/null)" == "true" ]]; then
  pass "LSUIElement is true (menu bar only, no Dock icon)"
else
  fail "LSUIElement is not true"
fi

for path in "$beacon/artifact.json" "$beacon/otelcol.json" "$contents/Resources/THIRD_PARTY_NOTICES.txt" "$contents/Resources/manifest.json"; do
  if [[ -s "$path" ]]; then pass "present: ${path#"$contents"/}"; else fail "missing: ${path#"$contents"/}"; fi
done
if [[ -d "$contents/MacOS/beacon" ]]; then
  fail "Contents/MacOS/beacon exists; data files there break the code signature seal"
fi
license_count=$(find "$contents/Resources/LICENSES" -type f 2>/dev/null | wc -l | tr -d ' ')
if (( license_count > 0 )); then pass "LICENSES: $license_count files"; else fail "LICENSES is empty"; fi

has_slice() { [[ " $(lipo -archs "$2" 2>/dev/null) " == *" $1 "* ]]; }

check_universal() {
  local label=$1 path=$2
  local architectures
  architectures=$(lipo -archs "$path" 2>/dev/null)
  if has_slice x86_64 "$path" && has_slice arm64 "$path"; then
    pass "$label is universal ($architectures)"
  else
    fail "$label is not universal (${architectures:-unreadable})"
  fi
}

check_universal "app executable" "$main_executable"
check_universal "companion" "$companion"
check_universal "beacon-hooks" "$beacon/beacon-hooks"
check_universal "beacon-otelcol" "$beacon/beacon-otelcol"

# `version` only reads the artifacts; a scratch HOME keeps it off the real one.
scratch=$(mktemp -d)
trap 'find "$scratch" -delete 2>/dev/null' EXIT
if version=$(env -i HOME="$scratch" BACKPLANE_COMPANION_HOME="$scratch/data" PATH=/usr/bin:/bin "$companion" version 2>&1); then
  pass "backplane-companion version runs"
else
  fail "backplane-companion version failed"
fi
printf '%s\n' "$version" | indent
verdict=$(/usr/bin/python3 - "$beacon" "$version" <<'PY'
import json, os, sys
beacon, text = sys.argv[1], sys.argv[2]
try:
    artifacts = json.loads(text)["artifacts"]
except (ValueError, KeyError, TypeError):
    print("FAIL  version output has no artifacts"); sys.exit()
for name, manifest in (("beacon_hooks", "artifact.json"), ("beacon_otelcol", "otelcol.json")):
    report = artifacts.get(name, {})
    expected = os.path.join(beacon, manifest)
    if report.get("verified") and os.path.realpath(report.get("manifest", "")) == os.path.realpath(expected):
        print(f"PASS  {name} verified from Resources/beacon/{manifest}")
    else:
        print(f"FAIL  {name}: {report}")
PY
)
printf '%s\n' "$verdict"
failures=$((failures + $(grep -c '^FAIL' <<<"$verdict")))

# --- x86_64 smoke (Intel Macs, or Rosetta 2 on Apple silicon) ----------------
# `arch` comes from PATH so a test can stand in for a Mac without Rosetta.
arch_command=$(command -v arch)
smoke_deadline_seconds=${VERIFY_MACOS_APP_SMOKE_DEADLINE_SECONDS:-30}

x86_64_smoke() {
  local name=$1 path=$2 subcommand=$3
  local label="x86_64 smoke: $name $subcommand"
  if ! has_slice x86_64 "$path"; then
    fail "x86_64 smoke: $name has no x86_64 slice"
    return
  fi
  local output
  # perl's alarm survives the exec, so a hung binary is killed instead of hanging the verifier.
  if output=$(env -i HOME="$scratch" BACKPLANE_COMPANION_HOME="$scratch/data" PATH=/usr/bin:/bin \
      /usr/bin/perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$smoke_deadline_seconds" \
      "$arch_command" -x86_64 "$path" "$subcommand" </dev/null 2>&1) && [[ -n "$output" ]]; then
    pass "$label"
  else
    fail "$label"
  fi
  printf '%s\n' "$output" | head -5 | indent
}

# The GUI is never run: its single-instance plugin would reach the owner's running app.
info "backplane-companion-desktop is not launched (GUI, single instance); its x86_64 slice is checked by lipo only"
if [[ -n "$arch_command" ]] && "$arch_command" -x86_64 /usr/bin/true 2>/dev/null; then
  info "x86_64 smoke on $(uname -m) host"
  x86_64_smoke backplane-companion "$companion" version
  x86_64_smoke beacon-hooks "$beacon/beacon-hooks" version
  x86_64_smoke beacon-otelcol "$beacon/beacon-otelcol" components
else
  skip "x86_64 smoke: Rosetta 2 is not installed (softwareupdate --install-rosetta); x86_64 slices were not run"
fi

echo
if (( failures )); then
  echo "verify_macos_app: $failures check(s) failed"
  exit 1
fi
if (( skipped )); then
  echo "verify_macos_app: no check failed, but $skipped check(s) SKIPPED; this is not a pass"
  exit 3
fi
echo "verify_macos_app: all checks passed"
