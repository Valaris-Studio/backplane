# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware

from app import __version__
from app.config import settings
from app.core.rate_limit import RateLimitMiddleware
from app.core.security_headers import SecurityHeadersMiddleware
from app.exceptions import ValarisError

HTTP_STATUS_ERROR_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
    501: "not_implemented",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
}


def _http_error_contract(
    status_code: int,
    detail: Any,
) -> tuple[str, dict[str, Any]]:
    if isinstance(detail, dict):
        embedded_code = detail.get("error_code") or detail.get("code")
        if isinstance(embedded_code, str) and embedded_code:
            params = {
                key: value
                for key, value in detail.items()
                if key not in {"code", "error_code", "detail"}
            }
            return embedded_code, params

    return HTTP_STATUS_ERROR_CODES.get(status_code, "http_error"), {}


def _validation_field_path(location: list[Any]) -> str:
    field = ""
    for segment in location:
        if isinstance(segment, int):
            field += f"[{segment}]"
        else:
            field += f".{segment}" if field else str(segment)
    return field

# WS-6.1: uvicorn only wires handlers for the `uvicorn.*` logger tree, so
# without this every app-level logger.info() is silently dropped. Attach a
# stdout handler at import time so VALARIS_EVENT_LOG and other INFO-level
# diagnostics surface in `docker logs`.
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def create_app() -> FastAPI:
    if settings.ENV == "production" and not (
        settings.IAP_AUDIENCE
        or settings.TRUSTED_PROXY_AUTH
        or settings.OIDC_ISSUER
        or settings.LOCAL_AUTH_ENABLED
    ):
        raise RuntimeError(
            "Refusing to start in production with no way to verify who a caller is. "
            "Leave LOCAL_AUTH_ENABLED=true for built-in email+password login, "
            "set OIDC_ISSUER to sign users in against your identity provider, "
            "IAP_AUDIENCE to verify Google IAP's signed JWT, or "
            "TRUSTED_PROXY_AUTH=true if the backend is reachable only through an "
            "authenticating proxy that sets TRUSTED_PROXY_AUTH_HEADER. "
            'See the docs section "Securing a Self-Hosted Deployment" and SECURITY.md.'
        )

    # Local auth and OIDC both mint a session cookie signed with
    # OAUTH_STATE_SIGNING_KEY (app/core/session_cookie.py). IAP needs no
    # signing key — Google's JWT is the credential — so it's exempt. Without
    # this check, a fresh self-host with the LOCAL_AUTH_ENABLED=true default
    # and an unset key starts fine, serves the first-run screen, and then
    # every login attempt 403s with "Session signing key is not configured":
    # a healthy-looking instance nobody can ever sign into.
    if (
        settings.ENV == "production"
        and (settings.LOCAL_AUTH_ENABLED or settings.OIDC_ISSUER)
        and not settings.OAUTH_STATE_SIGNING_KEY
    ):
        raise RuntimeError(
            "Refusing to start in production: LOCAL_AUTH_ENABLED or OIDC_ISSUER "
            "is on, but OAUTH_STATE_SIGNING_KEY is not set, so login sessions "
            "cannot be signed. Every sign-in attempt would fail with "
            '"Session signing key is not configured". Generate one with '
            "`openssl rand -hex 32` and set it as OAUTH_STATE_SIGNING_KEY."
        )

    application = FastAPI(
        title="Backplane",
        version=__version__,
        docs_url="/api/docs" if settings.is_development else None,
        # Schema is public in every env so self-hosters can generate clients;
        # only the interactive docs UI stays dev-only.
        openapi_url="/api/openapi.json",
    )

    # Compress large JSON (board detail, activity timeline — multi-MB raw,
    # 5-10x smaller gzipped; Cloud Run does not compress for us).
    #
    # Ordering matters: add_middleware makes the LAST-added the OUTERMOST, and
    # RateLimit/SecurityHeaders are BaseHTTPMiddleware — on the response path
    # they re-emit the body as an unsized stream (no Content-Length). If GZip
    # sat outside them it would receive that unsized stream and compress every
    # response, ignoring minimum_size. Added first, GZip is INNERMOST: it sees
    # the raw route response with Content-Length intact, so minimum_size skips
    # the tiny bodies. SecurityHeaders (outer) only setdefaults unrelated
    # headers afterward, so they still ride out on the compressed response.
    application.add_middleware(GZipMiddleware, minimum_size=1024)

    application.add_middleware(RateLimitMiddleware)

    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # allow_headers governs the REQUEST side only. Without this, a
        # cross-origin browser can read none of our custom response headers —
        # paginated list endpoints report their unpaged count as X-Total-Count
        # and it would silently arrive as undefined in the client.
        expose_headers=["X-Total-Count"],
    )

    application.add_middleware(SecurityHeadersMiddleware)

    @application.exception_handler(ValarisError)
    async def valaris_error_handler(_request: Request, exc: ValarisError):
        return JSONResponse(
            status_code=exc.status_code,
            content=jsonable_encoder(
                {
                    "detail": exc.detail,
                    "error_code": exc.error_code,
                    "error_params": exc.error_params,
                    "context": exc.context,
                }
            ),
        )

    @application.exception_handler(StarletteHTTPException)
    async def http_error_handler(_request: Request, exc: StarletteHTTPException):
        detail = jsonable_encoder(exc.detail)
        error_code, error_params = _http_error_contract(exc.status_code, detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "detail": detail,
                "error_code": error_code,
                "error_params": error_params,
                "context": None,
            },
            headers=exc.headers,
        )

    @application.exception_handler(RequestValidationError)
    async def request_validation_error_handler(
        _request: Request,
        exc: RequestValidationError,
    ):
        detail = jsonable_encoder(exc.errors())
        issues = [
            {
                "field": _validation_field_path(error.get("loc", [])),
                "code": error.get("type", "invalid"),
                "params": error.get("ctx") or {},
            }
            for error in detail
        ]
        return JSONResponse(
            status_code=422,
            content={
                "detail": detail,
                "error_code": "request_validation_error",
                "error_params": {"issues": issues},
                "context": None,
            },
        )

    from app.routers import product_documentation
    from app.routers import (
        activity,
        health,
        loop_templates as loop_templates_router,
        me,
        media,
        metrics as metrics_router,
        notifications as notifications_router,
        sensors as sensors_router,
        workspaces,
    )
    from app.routers.agents import (
        agents as agents_router,
        assignments as assignments_router,
        executions as executions_router,
        prompt_configs as prompt_configs_router,
        teams as teams_router,
        workspace_executions,
    )
    from app.routers.approvals import approvals as approvals_router
    from app.routers.channels import channels
    from app.routers.auth import local as local_auth_router
    from app.routers.auth import oidc as oidc_auth_router
    from app.routers.auth import setup as setup_auth_router
    from app.routers.definitions import definitions
    from app.routers.git import git_repos
    from app.routers.integrations import (
        config_status as integrations_config_status_router,
        git_connections as git_connections_router,
        oauth_github as oauth_github_router,
    )
    from app.routers.kanban import (
        board_context,
        board_dependencies,
        board_health,
        board_loop_templates,
        boards,
        card_dependencies,
        cards,
        columns,
    )
    from app.routers.notes import board_notes, card_verdict, workspace_notes
    from app.routers.resources import board_resources, workspace_resources
    from app.routers.skills import board_skills as board_skills_router
    from app.routers.skills import workspace_skills as workspace_skills_router
    from app.routers import events as events_router
    from app.routers import improvement as improvement_router
    from app.routers import merge_queue as merge_queue_router
    from app.routers.alerts import alert_thresholds
    from app.routers.webhooks import webhooks as webhooks_router
    from app.routers import workspace_config as workspace_config_router
    from app.routers import config as config_router

    application.include_router(health.router)
    application.include_router(product_documentation.router)
    application.include_router(oidc_auth_router.router)
    application.include_router(oidc_auth_router.modes_router)
    application.include_router(setup_auth_router.router)
    application.include_router(local_auth_router.router)
    application.include_router(me.router)
    application.include_router(notifications_router.router)
    application.include_router(agents_router.router)
    application.include_router(assignments_router.router)
    application.include_router(executions_router.router)
    application.include_router(workspace_executions.router)
    application.include_router(teams_router.router)
    application.include_router(prompt_configs_router.router)
    application.include_router(approvals_router.router)
    application.include_router(workspaces.router)
    application.include_router(boards.router)
    application.include_router(board_context.router)
    application.include_router(board_loop_templates.router)
    application.include_router(columns.router)
    from app.routers.kanban import completion
    application.include_router(completion.router)
    application.include_router(cards.router)
    application.include_router(card_dependencies.router)
    application.include_router(board_dependencies.router)
    application.include_router(board_health.router)
    application.include_router(activity.router)
    application.include_router(board_resources.router)
    application.include_router(workspace_resources.router)
    application.include_router(workspace_skills_router.router)
    application.include_router(workspace_skills_router.catalog_router)
    application.include_router(board_skills_router.router)
    application.include_router(media.router)
    application.include_router(definitions.router)
    application.include_router(channels.router)
    application.include_router(git_repos.router)
    application.include_router(oauth_github_router.router)
    application.include_router(git_connections_router.router)
    application.include_router(integrations_config_status_router.router)
    application.include_router(board_notes.router)
    application.include_router(card_verdict.router)
    application.include_router(workspace_notes.router)
    application.include_router(alert_thresholds.router)
    application.include_router(webhooks_router.router)
    application.include_router(events_router.router)
    application.include_router(improvement_router.router)
    application.include_router(metrics_router.router)
    application.include_router(workspace_config_router.router)
    application.include_router(workspace_config_router.breaker_router)
    application.include_router(workspace_config_router.role_labels_router)
    application.include_router(workspace_config_router.runner_config_router)
    application.include_router(sensors_router.router)
    application.include_router(loop_templates_router.router)
    application.include_router(merge_queue_router.router)
    application.include_router(config_router.router)

    from app.routers.local_storage import router as local_storage_router

    application.include_router(local_storage_router)

    from app.core.event_bus import event_bus, start_event_bus, stop_event_bus
    from app.database import async_session
    from app.services.agents.liveness import LivenessTracker
    from app.services.events.connection_manager import (
        connection_manager as ws_connection_manager,
    )
    from app.services.events.webhook_subscriber import WebhookSubscriber

    webhook_subscriber = WebhookSubscriber(event_bus, async_session)
    application.state.connection_manager = ws_connection_manager

    # Card 40424fb3 — runner liveness backup signal. The primary signal is
    # heartbeat-stops-arriving (caught at the WS layer); this loop publishes
    # `agent.status_changed` once `last_seen_at` crosses the stale/offline
    # threshold so the UI can flip the badge without an active runner WS.
    # Cloud Run rolling deploys mean multiple replicas may run this loop
    # briefly — duplicate transitions are tolerable (frontend keys on the
    # latest event) and per-process LivenessTracker dedupes within a replica.
    liveness_tracker = LivenessTracker()
    liveness_task: list = []  # holds the asyncio.Task so shutdown can cancel it
    # holds the bus unsubscribe so shutdown can detach the restart-probe listener
    restart_probe_unsubscribe: list = []
    LIVENESS_SCAN_INTERVAL_SECONDS = 30

    async def _liveness_loop():
        import asyncio

        while True:
            try:
                async with async_session() as db:
                    await liveness_tracker.scan_and_publish(db, event_bus)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger = logging.getLogger(__name__)
                logger.exception("liveness scan failed")
            await asyncio.sleep(LIVENESS_SCAN_INTERVAL_SECONDS)

    # PAR-2 — backend merge queue worker. Mirrors the liveness pattern: a
    # background loop calling MergeQueueService.tick(). Cloud Run replicas
    # share the same Postgres table; SELECT FOR UPDATE SKIP LOCKED in
    # pop_next gives per-(repo, integration_branch) serialization without a
    # distributed lock. PAR-3-wiring: the real MergeExecutor (clone +
    # rebase + gh merge) is built once at startup via
    # `make_merge_executor`; the loop only schedules its invocation.
    import os

    from app.services.merge_executor import make_merge_executor

    merge_queue_task: list = []
    MERGE_QUEUE_TICK_SECONDS = int(os.environ.get("MERGE_QUEUE_TICK_SECONDS", "10"))
    merge_executor = make_merge_executor(
        session_factory=async_session, settings=settings
    )

    async def _merge_queue_loop():
        import asyncio

        from app.services.merge_queue import run_merge_queue_tick

        while True:
            try:
                # Session + transaction + consolidator wiring live in
                # run_merge_queue_tick — this loop really is scheduling only.
                await run_merge_queue_tick(
                    async_session, event_bus=event_bus, executor=merge_executor
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger = logging.getLogger(__name__)
                logger.exception("merge queue tick failed")
            await asyncio.sleep(MERGE_QUEUE_TICK_SECONDS)

    # Loop starvation 3/3 — merged-PR → Done reconciler. Event path lands the
    # card when the platform's own merge queue merges its PR; the poll path
    # covers merges done directly on GitHub. Same replica posture as the merge
    # queue: duplicate poll passes across replicas are tolerable (landing is
    # idempotent), the event path is origin-only.
    from app.services.kanban.reconciler import MergedPRReconciler

    reconciler = MergedPRReconciler(session_factory=async_session)
    reconciler_task: list = []
    RECONCILER_TICK_SECONDS = int(os.environ.get("RECONCILER_TICK_SECONDS", "60"))

    async def _reconciler_loop():
        import asyncio

        while True:
            try:
                async with async_session() as db:
                    async with db.begin():
                        await reconciler.scan_once(db)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger = logging.getLogger(__name__)
                logger.exception("merged-PR reconciler pass failed")
            await asyncio.sleep(RECONCILER_TICK_SECONDS)

    @application.on_event("startup")
    async def startup_event_bus():
        import asyncio

        # Open the cross-instance transport (LISTEN connection) before the loops
        # start publishing. No-op under the in-memory default (EVENT_BUS_BACKEND).
        await start_event_bus(event_bus)
        # Restart probes are answered by whichever worker holds the runner's
        # socket, so every worker must be listening before any of them serves.
        restart_probe_unsubscribe.append(ws_connection_manager.listen_for_restart_probes())
        webhook_subscriber.start()
        reconciler.start(event_bus)
        liveness_task.append(asyncio.create_task(_liveness_loop()))
        merge_queue_task.append(asyncio.create_task(_merge_queue_loop()))
        reconciler_task.append(asyncio.create_task(_reconciler_loop()))

    @application.on_event("shutdown")
    async def shutdown_event_bus():
        webhook_subscriber.stop()
        reconciler.stop()
        for task in liveness_task:
            task.cancel()
        for task in merge_queue_task:
            task.cancel()
        for task in reconciler_task:
            task.cancel()
        for unsubscribe in restart_probe_unsubscribe:
            unsubscribe()
        restart_probe_unsubscribe.clear()
        await ws_connection_manager.shutdown()
        # Close the transport last, after nothing else publishes into it.
        await stop_event_bus(event_bus)

    _stamp_api_surfaces(application)

    return application


def _stamp_api_surfaces(application: FastAPI) -> None:
    """Annotate every operation with `x-surface` (see app/core/api_surfaces.py).

    A vendor extension rather than a tag: adopters and generated clients can
    read the stability promise, while Swagger's tag grouping stays as-is.
    """
    from fastapi.openapi.utils import get_openapi
    from fastapi.routing import APIRoute

    from app.core.api_surfaces import classify_route

    def openapi() -> dict:
        if application.openapi_schema:
            return application.openapi_schema

        schema = get_openapi(
            title=application.title,
            version=application.version,
            routes=application.routes,
        )
        # Key on the schema's own path spelling: FastAPI drops the converter
        # from `{file_path:path}` when it emits the document, so route.path
        # would miss those operations.
        surface_by_path_method = {
            (route.path_format, method.lower()): classify_route(route)
            for route in application.routes
            if isinstance(route, APIRoute)
            for method in route.methods
        }
        for path, operations in schema.get("paths", {}).items():
            for method, operation in operations.items():
                surface = surface_by_path_method.get((path, method))
                if surface:
                    operation["x-surface"] = surface

        application.openapi_schema = schema
        return schema

    application.openapi = openapi


app = create_app()
