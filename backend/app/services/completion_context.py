# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json

from app.exceptions import ConflictError
from app.repositories.definitions.definition import DefinitionRepository
from app.repositories.notes.note import NoteRepository
from app.services.agents.context_assembly import (
    render_board_definition,
    _clamp_limit,
    _MAX_CONTEXT_LIMIT,
)


MANDATORY_CONTEXT_LIMIT = 128 * 1024
EXECUTION_CONTEXT_LIMIT = 256 * 1024


async def assemble_mandatory_completion_context(db, board, policy):
    notes = NoteRepository(db)
    definition_record = await DefinitionRepository(db).get_by_board(board.id)
    board_notes = [n for n in await notes.list_by_board(board.id) if n.pinned and n.content]
    workspace_notes_records = [n for n in await notes.list_by_workspace(board.workspace_id) if n.pinned]
    definition_only = render_board_definition(definition_record, [])
    definition = render_board_definition(definition_record, board_notes)
    workspace_notes = "\n\n".join(f"NOTE — {n.title}:\n{n.content}" for n in workspace_notes_records)
    value = policy.model_dump() if hasattr(policy, "model_dump") else policy
    parts = [
        "MANDATORY LANDING AND COMPLETION CONTRACT",
        json.dumps(value, sort_keys=True),
        "The platform owns completion authorization. Use submit_completion_candidate with this iteration's source_execution_id to record work. "
        "For source work, submit the real open PR before merging. Use request_landing only for a permitted method. "
        "Independent review and exact merged-revision validation are scheduled by code. "
        "Do not change completion_mode or move unaccepted work to Done. "
        "Evidence-only work requires an operator-selected mode and exact source, artifact digests and check provenance. "
        "Read completion status with get_completion_status. A failed review requires correction before retry_completion; submit a fresh candidate when the source head changes. Recovery assignments include mandatory review findings. Use retry_completion for a resumable infrastructure failure after resolving its cause. "
        "Later main advancement does not change the exact commit being accepted.",
        definition,
        workspace_notes,
    ]
    context = "\n\n".join(parts)
    labels = ["contract_heading", "completion_policy", "platform_instructions"]
    contributors = [{"source": label, "bytes": len(part.encode("utf-8"))}
                    for label, part in zip(labels, parts[:3])]
    contributors.append({"source": "board_definition", "id": str(board.id), "bytes": len(definition_only.encode("utf-8"))})
    for note in [*board_notes, *workspace_notes_records]:
        contributors.append({"source": "note", "id": str(note.id), "title": note.title,
                             "bytes": len(f"NOTE — {note.title}:\n{note.content}".encode("utf-8"))})
    separators = 2 * (len(parts) - 1 + max(0, len(board_notes) + bool(definition_only) - 1)
                      + max(0, len(workspace_notes_records) - 1))
    contributors.append({"source": "section_separators", "bytes": separators})
    size = len(context.encode("utf-8"))
    return context, {"bytes": size, "limit_bytes": MANDATORY_CONTEXT_LIMIT,
                     "within_limit": size <= MANDATORY_CONTEXT_LIMIT,
                     "contributors": contributors}


async def mandatory_completion_context(db, board, policy):
    context, report = await assemble_mandatory_completion_context(db, board, policy)
    if not report["within_limit"]:
        raise ConflictError(
            "Mandatory completion context exceeds 128 KiB; reduce pinned context before running",
            error_code="completion_context_too_large",
        )
    return context


def render_completion_prompt(content, variables):
    return _process_completion_prompt(
        content,
        variables.keys(),
        variables["ContextSources"].keys(),
        resolve=lambda field, alias: (
            variables[field][alias] if alias is not None else variables[field]
        ),
    )


def validate_completion_prompt(content, context_sources):
    from app.services.agents.context_assembly import context_source_alias

    # Validate the same grammar against the execution contract, without fetching
    # or substituting card-dependent context during launch readiness.
    fields = {
        "Workspace", "BoardID", "BoardIDs", "CardID", "AgentID", "ExecutionID",
        "Branch", "PRURL", "SourceSHA", "ProjectDirectives", "ContextSources",
    }
    aliases = {
        alias for source in context_sources
        if (alias := context_source_alias(source)) is not None
    }
    _process_completion_prompt(content, fields, aliases)


def _process_completion_prompt(content, fields, aliases, resolve=None):
    """Walk both branches so validation and rendering accept the same grammar."""
    import re
    import shlex

    def invalid(expression):
        return ConflictError(
            f"Completion prompt cannot render '{expression}'; use claim identity fields, index .ContextSources, and if/else/end conditionals.",
            error_code="completion_prompt_render_invalid",
        )

    def value(expression):
        try:
            parts = shlex.split(expression)
        except ValueError as exc:
            raise invalid(expression) from exc
        if len(parts) == 1 and parts[0].startswith("."):
            key = parts[0][1:]
            if key in fields:
                return resolve(key, None) if resolve else None
        if len(parts) == 3 and parts[:2] == ["index", ".ContextSources"]:
            if parts[2] in aliases:
                return resolve("ContextSources", parts[2]) if resolve else None
        raise invalid(expression)

    output = []
    conditions = []
    active = True
    offset = 0
    for token in re.finditer(r"\{\{(.*?)\}\}", content, flags=re.DOTALL):
        literal = content[offset : token.start()]
        raw = token.group(1)
        if raw.startswith("-"):
            literal = literal.rstrip()
        if active:
            output.append(literal)
        expression = raw.strip().strip("-").strip()
        if expression.startswith("if "):
            if len(conditions) >= 32:
                raise invalid("condition nesting exceeds 32")
            condition = bool(value(expression[3:].strip()))
            conditions.append((active, condition, False))
            active = active and condition
        elif expression == "else":
            if not conditions or conditions[-1][2]:
                raise invalid(expression)
            parent, condition, _ = conditions[-1]
            conditions[-1] = (parent, condition, True)
            active = parent and not condition
        elif expression == "end":
            if not conditions:
                raise invalid(expression)
            active, _, _ = conditions.pop()
        else:
            rendered = value(expression)
            if active:
                output.append(str(rendered))
        offset = token.end()
        if raw.endswith("-"):
            while offset < len(content) and content[offset].isspace():
                offset += 1
    if conditions or "{{" in content[offset:]:
        raise invalid("unclosed template expression")
    output.append(content[offset:])
    return "".join(output)


async def completion_execution_context(
    db,
    board,
    card,
    candidate,
    execution,
    dispatch,
    *,
    kind,
    role,
    source_sha,
    checks,
    public_candidate,
):
    from app.repositories.completion_roles import CompletionRoleRepository
    from app.services.agents.context_assembly import assemble_context

    mandatory = await mandatory_completion_context(db, board, candidate.policy)
    sources = await assemble_context(
        db,
        workspace_id=board.workspace_id,
        card=card,
        board=board,
        sources=dispatch.stage.get("context_sources") or [],
        stage=dispatch.stage,
        pipeline_stages=dispatch.pipeline_stages,
    )
    variables = {
        "Workspace": await CompletionRoleRepository(db).workspace_slug(
            board.workspace_id
        ),
        "BoardID": str(board.id),
        "BoardIDs": str(board.id),
        "CardID": str(card.id),
        "AgentID": str(execution.agent_id),
        "ExecutionID": str(execution.id),
        "Branch": candidate.branch or "",
        "PRURL": candidate.pr_url or "",
        "SourceSHA": source_sha,
        "ProjectDirectives": mandatory,
        "ContextSources": sources,
    }
    role_prompt = (
        render_completion_prompt(dispatch.prompt.content, variables)
        if dispatch.prompt
        else ""
    )
    contract = {
        "instruction": "Backplane owns this completion contract. Use a fresh independent execution; inspect the exact revision and return attributed evidence. Do not reuse the source coding session. Mandatory context is injected by code.",
        "candidate": public_candidate,
        "card": {
            "id": str(card.id),
            "title": card.title,
            "description": card.description,
        },
        "kind": kind,
        "role": role,
        "source_sha": source_sha,
        "checks": checks,
        "context_sources": sources,
    }
    context = "\n\n".join(
        [
            mandatory,
            "MANDATORY CONFIGURED ROLE PROMPT\n" + role_prompt if role_prompt else "",
            json.dumps(contract, default=str, sort_keys=True),
        ]
    )
    if len(context.encode("utf-8")) > EXECUTION_CONTEXT_LIMIT:
        raise ConflictError(
            "Completion context exceeds 256 KiB; reduce evidence and pinned context",
            error_code="completion_context_too_large",
        )
    binding = {
        "context": context,
        "provider": dispatch.provider,
        "model": dispatch.model,
        "tool_policy": dispatch.tool_policy,
        "prompt_id": str(dispatch.prompt.id) if dispatch.prompt else None,
        "prompt_version": dispatch.prompt.version if dispatch.prompt else None,
        "prompt_slug": dispatch.prompt_slug,
    }
    return context, binding


async def completion_context_manifest(db, board, dispatch, binding, *, card=None):
    """Identify bound inputs without retaining another copy of their contents."""
    manifest = []

    def add(kind, ident, value):
        encoded = json.dumps(value, sort_keys=True, default=str, separators=(",", ":"))
        manifest.append({"kind": kind, "id": str(ident),
                         "hash": hashlib.sha256(encoded.encode("utf-8")).hexdigest()})

    notes = NoteRepository(db)
    for note in [*await notes.list_by_board(board.id),
                 *await notes.list_by_workspace(board.workspace_id)]:
        if note.pinned:
            add("note", note.id, [note.title, note.content])
    if card is not None:
        for source in dispatch.stage.get("context_sources") or []:
            if source.get("kind") != "card_notes":
                continue
            filter_ = source.get("filter") or {}
            records = (await notes.list_card_notes_by_kind(card.id, board.workspace_id, filter_["kind"])
                       if filter_.get("kind") else await notes.list_by_card(card.id, board.workspace_id))
            for note in records[:_clamp_limit(filter_, _MAX_CONTEXT_LIMIT)]:
                add("note", note.id, [note.title, note.content])
    definition = await DefinitionRepository(db).get_by_board(board.id)
    add("definition", board.id, [definition.scope, definition.content] if definition else None)
    if dispatch.prompt:
        add("prompt", dispatch.prompt.id, [dispatch.prompt.content, dispatch.prompt.version])
    add("configuration", board.id, {"policy": board.completion_policy,
        "provider": dispatch.provider, "model": dispatch.model, "tool_policy": dispatch.tool_policy,
        "stage": dispatch.stage, "pipeline_stages": dispatch.pipeline_stages})
    add("rendered_context", board.id, binding["context"])
    return manifest


def changed_context_sources(before, after):
    if before is None:
        return []
    previous = {(v["kind"], v["id"]): v["hash"] for v in before}
    current = {(v["kind"], v["id"]): v["hash"] for v in after}
    changed = [{"kind": kind, "id": ident,
                "change": "added" if (kind, ident) not in previous else
                          "removed" if (kind, ident) not in current else "changed"}
               for kind, ident in sorted(previous.keys() | current.keys())
               if previous.get((kind, ident)) != current.get((kind, ident))]
    specific = [value for value in changed if value["kind"] != "rendered_context"]
    return specific or changed
