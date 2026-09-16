# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Bounded, read-only forge checks after CompletionService authorizes the board.

Resolve database state serially; only network calls run concurrently. Unlike
operational forge reads, this diagnostic never records connection health or
invalidates candidates. Its report contains identifiers and allowlisted codes,
never provider response bodies, URLs, or credential resolver diagnostics.
"""

import asyncio
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken

from app.config import settings
from app.exceptions import BadGatewayError, ConflictError, ResourceNotFoundError
from app.integrations.git.exceptions import IntegrationsConfigError
from app.repositories.git.git_repo import GitRepoRepository
from app.services.completion_policy import policy_hash
from app.services.git.credential_resolver import CredentialResolver, ResolutionReason
from app.services.github_client import (
    ForgeAuthError,
    GitHubClient,
    is_github_pr_url,
    is_github_repo_url,
)

READINESS_TIMEOUT_SECONDS = 10
_NETWORK_CONCURRENCY = 4
_PENDING = {"awaiting_review", "awaiting_validation", "awaiting_merge"}


def _check(operation, *, repo_id=None, candidate_id=None, required=True, **values):
    return {
        "operation": operation, "repo_id": repo_id, "candidate_id": candidate_id,
        "required": required, "status": "unverified", "code": "readiness_timeout",
        **values,
    }


def _api_matches_credential(credential):
    # The supported completion client uses github.com repository/PR URLs.
    # Check its actual API destination too: resolver checks the git URL only.
    try:
        api = urlsplit(settings.GITHUB_API_URL)
        return (
            api.scheme == "https" and api.hostname == "api.github.com"
            and api.port in (None, 443) and not api.username and not api.password
            and api.path in ("", "/") and not api.query and not api.fragment
            and credential.host in ("github.com", "github.com:443")
        )
    except ValueError:
        return False


async def _probe(check, operation, semaphore):
    async with semaphore:
        try:
            await operation()
        except ForgeAuthError:
            check.update(status="failed", code="forge_auth_failed")
        except ResourceNotFoundError:
            check.update(status="failed", code="forge_not_found")
        except BadGatewayError:
            check.update(status="unverified", code="forge_unavailable")
        except ConflictError:
            check.update(status="failed", code="candidate_changed")
        except (ValueError, KeyError, TypeError, AttributeError):
            check.update(status="failed", code="forge_response_invalid")
        else:
            check.update(status="verified", code="verified")


async def completion_readiness(service, board, policy):
    try:
        async with asyncio.timeout(READINESS_TIMEOUT_SECONDS):
            return await _readiness(service, board, policy)
    except TimeoutError:
        # Discard partial success: configuration/credential resolution may not
        # have reached every repository before the deadline expired.
        return {
            "policy_hash": policy_hash(policy.model_dump()) if policy else None,
            "ready": False,
            "checks": [_check("repository_binding")],
        }


async def _readiness(service, board, policy):
    checks = []
    report = {"policy_hash": policy_hash(policy.model_dump()) if policy else None,
              "ready": True, "checks": checks}
    if policy is None:
        return report

    repos = await GitRepoRepository(service.db).list_by_board(board.id)
    repos = [repo for repo in repos if repo.workspace_id == board.workspace_id]
    if not repos:
        checks.append(_check("repository_binding", status="failed", code="repository_required"))
        report["ready"] = False
        return report

    candidates = {}
    for candidate in await service.repo.board_candidates(board.id):
        if candidate.status not in _PENDING or candidate.completion_mode == "evidence_only":
            continue
        card = await service.policy_service.repo.card(candidate.card_id, board.id)
        if card is None or await service.current_candidate(board, card, refresh=False) is None:
            continue
        candidates.setdefault(candidate.repo_id, []).append((candidate, card))

    jobs = []
    for repo in repos:
        binding = _check("repository_binding", repo_id=repo.id)
        checks.append(binding)
        # A read-only probe cannot establish merge or write authorization.
        write = _check("forge_write", repo_id=repo.id, required=False,
                       code="write_unverified")
        checks.append(write)
        if getattr(repo.provider, "value", repo.provider) != "github" or not is_github_repo_url(repo.url):
            binding.update(status="failed", code="forge_unsupported")
            continue
        try:
            resolver = CredentialResolver(service.db)
            resolved = await resolver.resolve(repo)
        except (InvalidToken, IntegrationsConfigError, ValueError, UnicodeError):
            binding.update(status="failed", code="credential_unavailable")
            continue
        credential = resolved.credential
        if credential is None:
            binding.update(status="failed", code=(
                "credential_host_mismatch" if resolved.reason == ResolutionReason.host_mismatch
                else "credential_unavailable"
            ))
            continue
        # An explicit missing/foreign binding must never silently use fallback.
        if repo.connection_id is not None and credential.connection_id != repo.connection_id:
            binding.update(status="failed", code="credential_unavailable")
            continue
        provenance = {
            "credential_source": "workspace_connection" if credential.connection_id else "platform",
            "connection_id": credential.connection_id,
        }
        binding.update(provenance)
        write.update(provenance)
        if not _api_matches_credential(credential):
            binding.update(status="failed", code="credential_host_mismatch")
            continue
        binding.update(status="verified", code="verified")
        client = GitHubClient(credential.token, base_url=settings.GITHUB_API_URL)

        def add(operation, callback, candidate_id=None):
            check = _check(operation, repo_id=repo.id, candidate_id=candidate_id, **provenance)
            checks.append(check)
            jobs.append((check, callback))

        add("repository_read", lambda client=client, url=repo.url: client.get_repository_access(url))
        add("pull_requests_read", lambda client=client, url=repo.url: client.list_open_prs(url))
        for candidate, card in candidates.get(repo.id, []):
            async def candidate_read(client=client, candidate=candidate, card=card, repo=repo):
                from app.services.completion import canonical_repo_url

                if (
                    not is_github_pr_url(candidate.pr_url)
                    or canonical_repo_url(candidate.pr_url.rsplit("/pull/", 1)[0]) != canonical_repo_url(repo.url)
                ):
                    raise ConflictError("Candidate repository changed")
                status = await client.get_pr_status(candidate.pr_url)
                service._validate_status(repo, card, status)
                if status.head_sha != candidate.source_sha:
                    raise ConflictError("Candidate head changed")

            add("candidate_pr_read", candidate_read, candidate.id)

    semaphore = asyncio.Semaphore(_NETWORK_CONCURRENCY)
    await asyncio.gather(*(_probe(check, operation, semaphore) for check, operation in jobs))
    report["ready"] = all(not check["required"] or check["status"] == "verified" for check in checks)
    return report
