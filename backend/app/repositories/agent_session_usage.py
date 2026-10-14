# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSession, AgentSessionUsage
from app.repositories.dialect_insert import conflict_aware_insert


@dataclass(frozen=True)
class UsageTotals:
    cost_reported_usd: Decimal | None
    cost_estimated_usd: Decimal | None
    cost_usd: Decimal | None
    unpriced_usage_count: int
    reasoning_tokens: int
    reported_count: int
    estimated_count: int


def _other_version(version: str):
    return or_(
        AgentSessionUsage.price_table_version.is_(None),
        AgentSessionUsage.price_table_version != version,
    )


def _source_count(source: str):
    return func.coalesce(
        func.sum(case((AgentSessionUsage.cost_source == source, 1), else_=0)), 0
    )


def _decimal(value) -> Decimal | None:
    return None if value is None else Decimal(str(value))


class AgentSessionUsageRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def insert_new(self, rows: list[dict]) -> int:
        """Insert usage rows, skipping events already recorded."""
        if not rows:
            return 0
        inserted = await self.db.scalars(
            conflict_aware_insert(self.db, AgentSessionUsage)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["session_id", "event_id"])
            .returning(AgentSessionUsage.id)
        )
        return len(inserted.all())

    async def for_events(
        self, session_id: uuid.UUID, event_ids: list[str]
    ) -> list[AgentSessionUsage]:
        if not event_ids:
            return []
        return list(
            await self.db.scalars(
                select(AgentSessionUsage).where(
                    AgentSessionUsage.session_id == session_id,
                    AgentSessionUsage.event_id.in_(event_ids),
                )
            )
        )

    async def totals(self, session_id: uuid.UUID) -> UsageTotals:
        row = (
            await self.db.execute(
                select(
                    func.sum(AgentSessionUsage.cost_reported_usd),
                    func.sum(AgentSessionUsage.cost_estimated_usd),
                    func.sum(
                        func.coalesce(
                            AgentSessionUsage.cost_reported_usd,
                            AgentSessionUsage.cost_estimated_usd,
                        )
                    ),
                    func.coalesce(
                        func.sum(
                            case((AgentSessionUsage.cost_source == "none", 1), else_=0)
                        ),
                        0,
                    ),
                    func.coalesce(func.sum(AgentSessionUsage.reasoning_tokens), 0),
                    _source_count("reported"),
                    _source_count("estimated"),
                ).where(AgentSessionUsage.session_id == session_id)
            )
        ).one()
        return UsageTotals(
            cost_reported_usd=_decimal(row[0]),
            cost_estimated_usd=_decimal(row[1]),
            cost_usd=_decimal(row[2]),
            unpriced_usage_count=int(row[3]),
            reasoning_tokens=int(row[4]),
            reported_count=int(row[5]),
            estimated_count=int(row[6]),
        )

    async def by_model(self, session_id: uuid.UUID, current_version: str) -> list:
        """Usage summed per model, provider, tier, auth kind and pricing status."""
        usage = AgentSessionUsage
        keys = (
            usage.model,
            usage.provider,
            usage.service_tier,
            usage.auth_kind,
            usage.pricing_status,
        )
        return list(
            (
                await self.db.execute(
                    select(
                        *keys,
                        func.count().label("usage_count"),
                        *(
                            func.sum(column).label(column.key)
                            for column in (
                                usage.input_uncached_tokens,
                                usage.cache_read_tokens,
                                usage.cache_write_5m_tokens,
                                usage.cache_write_1h_tokens,
                                usage.output_tokens,
                                usage.reasoning_tokens,
                                usage.cost_reported_usd,
                                usage.cost_estimated_usd,
                            )
                        ),
                        func.sum(
                            func.coalesce(
                                usage.cost_reported_usd, usage.cost_estimated_usd
                            )
                        ).label("cost_usd"),
                        _source_count("none").label("unpriced_usage_count"),
                        _source_count("reported").label("reported_count"),
                        _source_count("estimated").label("estimated_count"),
                        func.coalesce(
                            func.sum(
                                case((_other_version(current_version), 1), else_=0)
                            ),
                            0,
                        ).label("stale_usage_count"),
                    )
                    .where(usage.session_id == session_id)
                    .group_by(*keys)
                    .order_by(func.min(usage.occurred_at), *keys)
                )
            ).all()
        )

    async def missing_session_hints(
        self, session: AgentSession
    ) -> list[AgentSessionUsage]:
        """Rows that stated no provider, tier or auth kind of their own where
        the session now knows one."""
        gaps = []
        if session.provider:
            gaps.append(AgentSessionUsage.provider.is_(None))
        if session.service_tier:
            gaps.append(AgentSessionUsage.service_tier.is_(None))
        if session.auth_kind and session.auth_kind != "unknown":
            gaps.append(AgentSessionUsage.auth_kind == "unknown")
        if not gaps:
            return []
        return list(
            await self.db.scalars(
                select(AgentSessionUsage).where(
                    AgentSessionUsage.session_id == session.id, or_(*gaps)
                )
            )
        )

    async def a_session_priced_under_another_version(
        self, version: str
    ) -> uuid.UUID | None:
        return await self.db.scalar(
            select(AgentSessionUsage.session_id).where(_other_version(version)).limit(1)
        )

    async def rows_priced_under_other_versions(
        self, session_id: uuid.UUID, version: str
    ) -> list[AgentSessionUsage]:
        return list(
            await self.db.scalars(
                select(AgentSessionUsage)
                .where(
                    AgentSessionUsage.session_id == session_id, _other_version(version)
                )
                .execution_options(populate_existing=True)
            )
        )

    async def lock_session(self, session_id: uuid.UUID) -> AgentSession:
        return await self.db.scalar(
            select(AgentSession)
            .where(AgentSession.id == session_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )
