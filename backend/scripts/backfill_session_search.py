# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Backfill the private session search index for retained sessions, in
bounded passes an operator invokes one at a time.

Usage:
    source .venv/bin/activate
    python -m scripts.backfill_session_search start --scope all-workspaces
    python -m scripts.backfill_session_search pass --run-id RUN_ID
    python -m scripts.backfill_session_search status --run-id RUN_ID

`start` returns the lane's run for this configuration, creating it when there
is none. `--new-verification-epoch` begins another run after a finished one;
`--supersede-run RUN_ID` replaces that unfinished run once its lease lapsed.
`pass` does one bounded unit of work and exits: repeat it while it exits 10,
and after the receipt's earliest retry time while it exits 12. Unfinished pass
receipts report coverage and readiness as null to avoid scanning the whole scope for
each bounded batch. `start`, `status` and finished passes observe fresh
coverage; `status` only reads.

Every command prints exactly one JSON receipt (schema session-search-backfill/1)
on stdout (except explicit human-readable --help) and exits with its code: 0 done (created, existing, or ready at
observation), 1 unexpected failure, 2 usage or unknown run, 3 feature, schema
or configuration mismatch, 10 progress, 11 lease busy or lost, 12 retry
backoff, 13 exhausted or incomplete readiness. A receipt carries counts,
sizes, times and run ids only. Stderr carries fixed diagnostics: records other
modules log are reduced to their logger and level, because some of them carry
exception text that can name storage locations or private content."""

import argparse
import asyncio
import json
import logging
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.schemas.session_search_backfill import BackfillReceipt, Reason, Result

COMMANDS = ("start", "pass", "status")
# The largest accepted text body plus its integrity sentinel byte, so every
# supported object fits a fresh pass.
MIN_PASS_BYTE_BUDGET = (32 << 20) + 1
EXIT_FAILURE = 1
EXIT_USAGE = 2

log = logging.getLogger("session_search_backfill")


class _UsageError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's message echoes the rejected value; the receipt says only
        # that usage was wrong.
        raise _UsageError


def _bounded(low: int, high: int):
    def parse(text: str) -> int:
        value = int(text)
        if not low <= value <= high:
            raise ValueError
        return value

    return parse


def _parser() -> argparse.ArgumentParser:
    # Runtime imports can fail on operator configuration. They must occur
    # inside main's private-safe receipt boundary, including parser limits.
    from app.services.session_search_backfill import (
        DEFAULT_BYTE_BUDGET,
        MAX_PASS_SOURCES,
    )

    parser = _Parser(
        prog="python -m scripts.backfill_session_search",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start")
    start.add_argument("--scope", choices=["all-workspaces"], required=True)
    start.add_argument("--new-verification-epoch", action="store_true")
    start.add_argument("--supersede-run", type=uuid.UUID, metavar="RUN_ID")
    step = commands.add_parser("pass")
    step.add_argument("--run-id", type=uuid.UUID, required=True)
    step.add_argument(
        "--source-limit",
        type=_bounded(1, MAX_PASS_SOURCES),
        default=MAX_PASS_SOURCES,
    )
    step.add_argument(
        "--byte-budget",
        type=_bounded(MIN_PASS_BYTE_BUDGET, DEFAULT_BYTE_BUDGET),
        default=DEFAULT_BYTE_BUDGET,
    )
    status = commands.add_parser("status")
    status.add_argument("--run-id", type=uuid.UUID, required=True)
    return parser


class _WithheldDetail(logging.Filter):
    """Only this script's own fixed messages pass whole; any other record keeps
    its logger and level and loses its message, arguments and traceback."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name != log.name:
            record.msg = "%s %s (detail withheld)"
            record.args = (record.name, record.levelname)
            record.exc_info = record.exc_text = record.stack_info = None
        return True


def _guard_diagnostics() -> None:
    """One stderr handler for every log record and warning. Handlers other
    modules attached are removed (SQLAlchemy's echo handler writes to stdout,
    which carries only the receipt)."""
    for logger in list(logging.Logger.manager.loggerDict.values()):
        if isinstance(logger, logging.Logger):
            logger.handlers.clear()
            logger.propagate = True
    handler = logging.StreamHandler(sys.stderr)
    handler.addFilter(_WithheldDetail())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.WARNING)
    logging.captureWarnings(True)


def _receipt(
    command: str | None, result: Result, reason: Reason, exit_code: int
) -> BackfillReceipt:
    return BackfillReceipt(
        command=command if command in COMMANDS else None,
        result=result,
        reason=reason,
        exit_code=exit_code,
        observed_at=datetime.now(timezone.utc),
    )


async def _run(engine: AsyncEngine, args: argparse.Namespace) -> BackfillReceipt:
    try:
        from app.services.session_search_backfill import (
            EXIT_MISMATCH,
            SessionSearchBackfillService,
        )

        service = SessionSearchBackfillService(
            async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        )
        if not await service.schema_ready():
            return _receipt(args.command, "refused", "schema_missing", EXIT_MISMATCH)
        if args.command == "start":
            return await service.start_run(
                scope="all_workspaces",
                new_verification_epoch=args.new_verification_epoch,
                supersede_run_id=args.supersede_run,
            )
        if args.command == "pass":
            return await service.run_pass(
                args.run_id,
                source_limit=args.source_limit,
                byte_budget=args.byte_budget,
            )
        return await service.status(args.run_id)
    finally:
        await engine.dispose()


def _emit(receipt: BackfillReceipt) -> int:
    document = receipt.model_dump(mode="json", by_alias=True)
    sys.stdout.write(json.dumps(document, sort_keys=True) + "\n")
    return receipt.exit_code


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    command = arguments[0] if arguments and arguments[0] in COMMANDS else None
    _guard_diagnostics()
    try:
        parser = _parser()
        try:
            args = parser.parse_args(arguments)
        except _UsageError:
            sys.stderr.write(parser.format_usage())
            return _emit(_receipt(command, "refused", "usage", EXIT_USAGE))
        from app.config import settings
        from app.database import build_engine

        engine = build_engine(settings.DATABASE_URL)
        # build_engine echoes SQL in development; silence it and remove any
        # import-time handlers before a statement can run.
        engine.sync_engine.echo = False
        _guard_diagnostics()
        receipt = asyncio.run(_run(engine, args))
    except Exception as error:
        # Includes bootstrap, engine construction and disposal. Emit only
        # after cleanup succeeds, so a disposal failure cannot follow a
        # previously printed success/refusal with a second receipt.
        _guard_diagnostics()
        log.error("%s failed unexpectedly (%s)", command, type(error).__name__)
        receipt = _receipt(command, "failed", "unexpected_failure", EXIT_FAILURE)
    return _emit(receipt)


if __name__ == "__main__":
    raise SystemExit(main())
