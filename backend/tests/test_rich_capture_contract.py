# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The rich-capture contract: every example under
contracts/rich-capture/wire/ validates against the model it names and
round-trips through it unchanged; every example under wire/invalid/ is
rejected; every native-source manifest under contracts/rich-capture/sources/
states its expected coverage in the contract's vocabulary. Implementations
(backend routes, the companion uplink and readers) are tested against these
same files."""

import base64
import gzip
import hashlib
import io
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from app.core.local_paths import place_text
from app.schemas import session_content
from app.schemas.companion import MAX_INGEST_RECORD_BYTES

CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "rich-capture"
WIRE = CONTRACT / "wire"
VALID = sorted(WIRE.glob("*.json"))
INVALID = sorted((WIRE / "invalid").glob("*.json"))
MANIFESTS = sorted((CONTRACT / "sources").glob("*/manifest.json"))
PLACEMENT_VECTORS = CONTRACT / "placement-vectors.json"
SURFACES = {"claude-code", "codex-cli", "codex-desktop", "pi"}

# The contract's content classes (contract §9). A manifest row says how the
# class is captured on its surface: as content items, as events or native
# metadata only, or not at all.
CONTENT_CLASSES = frozenset(
    {
        "prompt",
        "correction",
        "repeated_identical_prompt",
        "attachment_file",
        "attachment_image",
        "reply",
        "reasoning_summary",
        "reasoning_raw",
        "tool_input",
        "tool_output",
        "command",
        "command_output",
        "file_edit",
        "mcp_call",
        "user_shell_command",
        "error",
        "compaction_summary",
        "instructions",
        "harness_context",
        "subagent",
        "native_records",
    }
)
# Never content on any surface (contract §8): metadata, events, lifecycle,
# and capabilities whose absence is not a content item.
NEVER_CONTENT_CLASSES = frozenset(
    {
        "command_exit_code",
        "command_duration",
        "approval",
        "interruption",
        "model_identity",
        "usage",
        "repo_identity",
        "resume",
        "fork",
        "plan",
        "turn_diff",
    }
)
# Codex Desktop shares Codex CLI's core: its manifest lists what differs.
MANIFEST_BASE = {"codex-desktop": "codex-cli"}
# The uplink reads at most this much of any response (uplink.go maxResponseBytes).
DEVICE_MAX_RESPONSE_BYTES = 4 << 20


def _example(path: Path) -> dict:
    example = json.loads(path.read_text())
    assert set(example) <= {"model", "http", "body", "why"}, path.name
    assert (
        example["model"] in session_content.WIRE_MODELS
    ), f"{path.name} names {example['model']}, not a wire model"
    return example


def _model(example: dict) -> type[BaseModel]:
    return session_content.WIRE_MODELS[example["model"]]


def test_contract_has_examples():
    assert VALID and INVALID


@pytest.mark.parametrize("path", VALID, ids=lambda path: path.stem)
def test_wire_example_round_trips(path: Path):
    example = _example(path)
    assert {"model", "http", "body"} <= set(example), path.name
    parsed = _model(example).model_validate(example["body"])
    dumped = parsed.model_dump(mode="json", exclude_unset=True)
    assert _model(example).model_validate(dumped) == parsed
    assert json.loads(json.dumps(dumped)) == _normalized_times(example["body"], dumped)


@pytest.mark.parametrize("path", INVALID, ids=lambda path: path.stem)
def test_invalid_wire_example_is_rejected(path: Path):
    example = _example(path)
    assert example.get("why"), f"{path.name} must say why it is invalid"
    with pytest.raises(ValidationError):
        _model(example).model_validate(example["body"])


def test_every_wire_model_has_a_valid_example():
    exemplified = {_example(path)["model"] for path in VALID}
    assert set(session_content.WIRE_MODELS) <= exemplified


def test_inline_examples_state_their_own_size_and_digest():
    for path in VALID:
        for declaration in _declarations(_example(path)):
            if declaration.get("inline_text") is not None:
                encoded = declaration["inline_text"].encode()
                assert declaration["byte_count"] == len(encoded), path.name
                assert declaration["sha256"] == hashlib.sha256(encoded).hexdigest()


def test_chunk_examples_state_their_own_size_and_digest():
    for path in VALID:
        example = _example(path)
        if example["model"] == "ChunkUploadHeaders":
            chunk = base64.b64decode(example["http"]["body_base64"])
            assert example["body"]["content_length"] == len(chunk)
            assert example["body"]["backplane_chunk_sha256"] == (
                hashlib.sha256(chunk).hexdigest()
            )


def test_budgets_are_consistent():
    budget = session_content
    # A largest body fits within the chunks one upload may have.
    assert budget.CHUNK_BYTES * budget.MAX_CHUNKS >= budget.MAX_TEXT_BODY_BYTES
    assert budget.CHUNK_BYTES * budget.MAX_CHUNKS >= budget.MAX_ATTACHMENT_BYTES
    # GCS composes at most 32 sources in one call.
    assert budget.MAX_CHUNKS <= 32
    # A chunk plus headers stays far below Cloud Run's 32 MiB request limit.
    assert budget.CHUNK_BYTES <= 8 << 20
    # Inline bodies never crowd the record out of its 4 MiB budget.
    assert budget.MAX_INLINE_BYTES_PER_RECORD <= MAX_INGEST_RECORD_BYTES // 2
    assert budget.MAX_INLINE_BODY_BYTES <= budget.MAX_INLINE_BYTES_PER_RECORD
    assert budget.MAX_SESSION_BODY_BYTES <= budget.MAX_INSTALLATION_BODY_BYTES
    assert budget.PREVIEW_BYTES <= budget.MAX_INLINE_BODY_BYTES


def test_worst_case_ingest_response_fits_the_device_read_limit():
    """Every declaration of a full batch answered with the largest ack must
    still be readable by the device, or settlement wedges."""
    expires = datetime(2026, 10, 15, tzinfo=timezone.utc)
    upload = session_content.UploadSlot(
        chunk_bytes=session_content.CHUNK_BYTES,
        chunk_count=session_content.MAX_CHUNKS,
        received_chunks=list(range(session_content.MAX_CHUNKS - 1)),
        expires_at=expires,
    )
    largest = max(
        (
            session_content.ContentAck(
                capture_id="f" * 32,
                content_key="f" * 64,
                outcome="upload_required",
                content_id=uuid.uuid4(),
                upload=upload,
            ),
            session_content.ContentAck(
                capture_id="f" * 32,
                content_key="f" * 64,
                outcome="recorded",
                content_id=uuid.uuid4(),
                coverage="collection_failed",
                coverage_reason="placement_failed",
            ),
        ),
        key=lambda ack: len(ack.model_dump_json()),
    )
    records = 32
    response = session_content.RichIngestResult(
        acknowledged=["f" * 32] * records,
        rejected=[],
        contents=[largest] * (records * session_content.MAX_CONTENTS_PER_RECORD),
    )
    assert len(response.model_dump_json()) < DEVICE_MAX_RESPONSE_BYTES


def _placement_vectors() -> list[dict]:
    return json.loads(PLACEMENT_VECTORS.read_text())["vectors"]


@pytest.mark.parametrize(
    "vector", _placement_vectors() if PLACEMENT_VECTORS.exists() else [None]
)
def test_server_placement_keeps_device_placed_text(vector):
    """The server's placement backstop must be the identity on text the
    device already placed, or whole classes of bodies would be withheld as
    placement_failed. The Go side asserts it produces `device_placed`."""
    assert vector is not None, "contracts/rich-capture/placement-vectors.json"
    placed = vector["device_placed"]
    assert vector["raw"] != placed or "stays" in vector["name"], vector["name"]
    assert place_text(placed, vector["roots"]) == placed, vector["name"]


def _placement_gaps() -> list:
    gaps = [
        vector
        for vector in (_placement_vectors() if PLACEMENT_VECTORS.exists() else [])
        if "RC-02" in vector.get("expected_fix_in", [])
    ]
    return [pytest.param(vector, id=vector["name"]) for vector in gaps] or [None]


@pytest.mark.parametrize("vector", _placement_gaps())
def test_server_backstop_flags_unplaced_root(vector):
    """A root spelled with forward slashes on Windows, in another case on a
    case-insensitive system, or JSON-escaped is still caught by the server
    check (R3-3, server half)."""
    assert vector is not None, "placement-vectors.json lists the known gaps"
    assert place_text(vector["raw"], vector["roots"]) != vector["raw"]


def test_placement_gaps_name_their_fixing_cards():
    for vector in _placement_vectors():
        assert set(vector.get("expected_fix_in", [])) <= {"RC-02", "RC-03"}


def test_every_surface_has_a_manifest():
    assert {path.parent.name for path in MANIFESTS} == SURFACES


def _manifest_file_rows() -> list[tuple[Path, dict]]:
    rows = []
    for manifest_path in MANIFESTS:
        manifest = json.loads(manifest_path.read_text())
        surface = manifest_path.parent
        if isinstance(manifest.get("files"), dict):
            rows += [(surface / name, row) for name, row in manifest["files"].items()]
        rows += [(surface / row["file"], row) for row in manifest.get("fixtures", [])]
    return rows


@pytest.mark.parametrize(
    ("path", "row"), _manifest_file_rows(), ids=lambda value: value.name if isinstance(value, Path) else ""
)
def test_manifest_sizes_and_digests_match_the_committed_bytes(path: Path, row: dict):
    """A provenance claim has to stay checkable: every size, line count and
    digest a manifest records is the committed file's."""
    stored = path.read_bytes()
    data = gzip.decompress(stored) if path.suffix == ".gz" else stored
    if path.suffix == ".gz" and "bytes_uncompressed" in row:
        assert row["bytes_uncompressed"] == len(data)
    if "sha256_uncompressed" in row:
        assert row["sha256_uncompressed"] == hashlib.sha256(data).hexdigest()
    if "bytes" in row:
        assert row["bytes"] == len(stored)
    if "sha256" in row:
        assert row["sha256"] == hashlib.sha256(stored).hexdigest()
    if "lines" in row:
        assert row["lines"] == data.count(b"\n")
    if "largest_line" in row:
        assert row["largest_line"] == max(len(line) for line in data.split(b"\n"))


@pytest.mark.parametrize(
    "path", sorted((CONTRACT / "sources").rglob("*.gz")), ids=lambda path: path.name
)
def test_gzip_fixtures_are_byte_reproducible(path: Path):
    """Gzip members are written with level 9, mtime 0 and their member name,
    so a re-sanitized fixture yields the same archive bytes on any machine."""
    stored = path.read_bytes()
    rebuilt = io.BytesIO()
    with gzip.GzipFile(
        filename=path.name.removesuffix(".gz"), mode="wb", fileobj=rebuilt, compresslevel=9, mtime=0
    ) as archive:
        archive.write(gzip.decompress(stored))
    assert rebuilt.getvalue() == stored


@pytest.mark.parametrize("surface", sorted(SURFACES))
def test_manifest_states_every_class(surface: str):
    """Each class has a designated source or an explicit status on every
    surface; silence is not a status."""
    rows = _coverage(surface)
    missing = (CONTENT_CLASSES | NEVER_CONTENT_CLASSES) - set(rows)
    assert not missing, f"{surface} states nothing for {sorted(missing)}"


def _coverage(surface: str) -> dict:
    rows = {}
    if surface in MANIFEST_BASE:
        rows |= _coverage(MANIFEST_BASE[surface])
    manifest = CONTRACT / "sources" / surface / "manifest.json"
    return rows | json.loads(manifest.read_text())["expected_coverage"]


@pytest.mark.parametrize("path", MANIFESTS, ids=lambda path: path.parent.name)
def test_manifest_uses_the_coverage_enum(path: Path):
    manifest = json.loads(path.read_text())
    rows = manifest["expected_coverage"]
    unknown = set(rows) - CONTENT_CLASSES - NEVER_CONTENT_CLASSES
    assert not unknown, f"{path.parent.name}: classes outside the contract {unknown}"
    for name, row in rows.items():
        _check_manifest_row(f"{path.parent.name}.{name}", name, row)
        for part in row.get("parts", []):
            assert part.get("when"), f"{name}: every part says when it applies"
            _check_manifest_row(f"{path.parent.name}.{name}[part]", name, part)


def _check_manifest_row(where: str, name: str, row: dict) -> None:
    kind, state, reason = row.get("as"), row.get("expected_state"), row.get("reason")
    assert kind in ("content", "event", "absent", "not_exercised"), f"{where}: {kind}"
    if kind == "content":
        assert name in CONTENT_CLASSES, f"{where}: never declared as content"
        assert state in session_content.COVERAGE_REASONS, f"{where}: {state}"
        assert state not in session_content.SERVER_ONLY_COVERAGE, where
        allowed = session_content.COVERAGE_REASONS[state]
        assert (reason is None) == (not allowed) and (
            reason is None or reason in allowed
        ), f"{where}: {state}/{reason}"
    else:
        assert state is None, f"{where}: {kind} rows declare no coverage"
        assert reason in (None, "source_not_supported"), f"{where}: {reason}"
        assert reason is None or kind == "absent", where


def _normalized_times(body, dumped):
    """`body` with each timestamp the model re-serialized replaced by its
    dump, after checking both name the same instant."""
    if isinstance(body, dict) and isinstance(dumped, dict):
        return {
            key: _normalized_times(value, dumped.get(key))
            for key, value in body.items()
        }
    if isinstance(body, list) and isinstance(dumped, list):
        return [_normalized_times(a, b) for a, b in zip(body, dumped)]
    if isinstance(body, str) and isinstance(dumped, str) and body != dumped:
        assert datetime.fromisoformat(body) == datetime.fromisoformat(dumped)
        return dumped
    return body


def _declarations(example: dict) -> list[dict]:
    body = example["body"]
    if example["model"] == "RichCaptureRecord":
        return body.get("contents", [])
    if example["model"] == "ContentDeclaration":
        return [body]
    return []
