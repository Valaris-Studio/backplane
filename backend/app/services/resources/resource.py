# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import posixpath
import uuid

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BadRequestError, ResourceNotFoundError, ValidationError
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.resources.resource import ResourceType
from app.repositories.resources.resource import ResourceRepository
from app.schemas.resources.resource import ResourceCreate, ResourceMetadata, ResourceUpdate
from app.services.activity import ActivityService
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.utils import shallow_merge_dicts


class ResourceService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ResourceRepository(db)
        self.activity = ActivityService(db)

    def _validate_metadata(self, metadata: dict) -> dict:
        try:
            validated = ResourceMetadata(**metadata)
            return validated.model_dump()
        except PydanticValidationError as e:
            msg = e.errors()[0]["msg"] if e.errors() else "Invalid metadata"
            raise ValidationError(msg)

    def _validate_gcs_path(self, gcs_path: str, workspace_id: uuid.UUID) -> str:
        """Confine an object key to the caller's workspace prefix.

        The key is later signed for download against the shared bucket, and the
        resource itself passes the workspace check because it really does belong
        to the caller — so an unconfined key reads another tenant's objects.

        Rejects any key not already in normal form rather than rewriting it: a
        prefix check alone accepts "{workspace_id}/../{other}/secret", whose
        resolved key escapes, and silently normalising would leave the stored
        key differing from the one actually uploaded.
        """
        prefix = f"{workspace_id}/"
        normalised = posixpath.normpath(gcs_path)
        if (
            gcs_path.startswith("/")
            or normalised != gcs_path
            or not normalised.startswith(prefix)
        ):
            raise ValidationError(
                f"gcs_path must be a normalised key under this workspace's prefix ({prefix})"
            )
        return gcs_path

    @staticmethod
    def _key_segment(name: str) -> str:
        """Reduce a display name to one safe path segment for a generated key.

        `name` is free text the user chose for a file, not a path they chose for
        storage — so "../../other-workspace/x" must become a harmless segment
        rather than a 422. Taking the basename also stops "a/b.pdf" silently
        creating a nested key, which it did before this guard existed.
        """
        segment = posixpath.basename(name.strip().rstrip("/"))
        return segment if segment and segment.strip(".") else "file"

    async def create_resource(
        self,
        workspace_id: uuid.UUID,
        data: ResourceCreate,
        user_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
    ):
        await assert_board_not_frozen(self.db, board_id)
        if data.parent_id:
            await self._validate_parent(data.parent_id, workspace_id)

        metadata = {}
        if data.metadata:
            metadata = self._validate_metadata(data.metadata)

        gcs_path = data.gcs_path
        if not gcs_path and data.resource_type == ResourceType.file:
            gcs_path = f"{workspace_id}/{uuid.uuid4()}/{self._key_segment(data.name)}"
        # Both branches, not just the supplied one: the generated key
        # interpolates the caller's chosen name, so it needs the same invariant.
        if gcs_path and data.resource_type == ResourceType.file:
            gcs_path = self._validate_gcs_path(gcs_path, workspace_id)

        resource = await self.repo.create(
            workspace_id=workspace_id,
            board_id=board_id,
            parent_id=data.parent_id,
            resource_type=data.resource_type,
            name=data.name,
            gcs_path=gcs_path if data.resource_type == ResourceType.file else None,
            mime_type=data.mime_type if data.resource_type == ResourceType.file else None,
            size_bytes=data.size_bytes if data.resource_type == ResourceType.file else None,
            uploaded_by=user_id,
            meta=metadata,
            description=data.description,
        )

        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.resource,
            entity_id=resource.id,
            action=ActivityAction.created,
            board_id=board_id,
            summary=f"created {data.resource_type.value} '{data.name}'",
            message_key="activity.resource.created",
            message_params={
                "resource_name": data.name,
                "resource_type": data.resource_type.value,
            },
        )

        return resource

    async def list_resources(
        self,
        workspace_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
        parent_id: uuid.UUID | None = None,
        q: str | None = None,
        resource_type: str | None = None,
        tag: str | None = None,
    ):
        has_filters = q or resource_type or tag

        if has_filters:
            if board_id:
                return await self.repo.search(
                    workspace_id=workspace_id or uuid.UUID(int=0),
                    board_id=board_id,
                    q=q,
                    resource_type=resource_type,
                    tag=tag,
                )
            if workspace_id:
                return await self.repo.search(
                    workspace_id=workspace_id,
                    q=q,
                    resource_type=resource_type,
                    tag=tag,
                )
            return []

        if parent_id:
            return await self.repo.list_by_parent(parent_id)
        if board_id:
            return await self.repo.list_root_by_board(board_id)
        if workspace_id:
            return await self.repo.list_root_by_workspace(workspace_id)
        return []

    async def list_tags(
        self,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
    ) -> list[str]:
        return await self.repo.list_tags(workspace_id, board_id)

    async def get_resource(self, resource_id: uuid.UUID, workspace_id: uuid.UUID):
        resource = await self.repo.get_by_id(resource_id)
        if not resource or resource.workspace_id != workspace_id:
            raise ResourceNotFoundError("Resource not found")
        return resource

    async def get_resource_for_signing(
        self, resource_id: uuid.UUID, workspace_id: uuid.UUID
    ):
        resource = await self.get_resource(resource_id, workspace_id)
        if not resource.gcs_path:
            raise BadRequestError("Resource has no file")
        # Rows stored before the create-time guard can carry a foreign key, and
        # the local-storage fallback grants the same read as a signed URL — so
        # re-validate before either kind of URL is produced.
        self._validate_gcs_path(resource.gcs_path, workspace_id)
        return resource

    async def update_resource(
        self,
        resource_id: uuid.UUID,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        data: ResourceUpdate,
    ):
        resource = await self.repo.get_by_id(resource_id)
        if not resource or resource.workspace_id != workspace_id:
            raise ResourceNotFoundError("Resource not found")
        await assert_board_not_frozen(self.db, resource.board_id)

        update_data = data.model_dump(exclude_unset=True)

        if "metadata" in update_data:
            raw_meta = update_data.pop("metadata")
            if resource.meta:
                raw_meta = shallow_merge_dicts(resource.meta, raw_meta)
            update_data["meta"] = self._validate_metadata(raw_meta)

        if "parent_id" in update_data:
            new_parent_id = update_data["parent_id"]
            if new_parent_id:
                if new_parent_id == resource_id:
                    raise ValidationError("Cannot move resource into itself")
                await self._validate_parent(new_parent_id, workspace_id)
                await self._check_circular_reference(resource_id, new_parent_id)

        updated = await self.repo.update(resource, **update_data)

        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.resource,
            entity_id=resource_id,
            action=ActivityAction.updated,
            board_id=resource.board_id,
            summary=f"updated resource '{updated.name}'",
            message_key="activity.resource.updated",
            message_params={"resource_name": updated.name},
        )

        return updated

    async def delete_resource(
        self,
        resource_id: uuid.UUID,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
    ):
        resource = await self.repo.get_by_id(resource_id)
        if not resource or resource.workspace_id != workspace_id:
            raise ResourceNotFoundError("Resource not found")
        await assert_board_not_frozen(self.db, resource.board_id)

        name = resource.name
        board_id = resource.board_id

        await self.repo.delete(resource)

        await self.activity.record(
            workspace_id=workspace_id,
            actor_id=user_id,
            entity_type=ActivityEntityType.resource,
            entity_id=resource_id,
            action=ActivityAction.deleted,
            board_id=board_id,
            summary=f"deleted resource '{name}'",
            message_key="activity.resource.deleted",
            message_params={"resource_name": name},
        )

    async def _validate_parent(self, parent_id: uuid.UUID, workspace_id: uuid.UUID):
        parent = await self.repo.get_by_id(parent_id)
        if not parent or parent.workspace_id != workspace_id:
            raise ResourceNotFoundError("Parent folder not found")
        if parent.resource_type != ResourceType.folder:
            raise ValidationError("Parent must be a folder")

    async def _check_circular_reference(
        self, resource_id: uuid.UUID, new_parent_id: uuid.UUID
    ):
        current_id = new_parent_id
        visited = {resource_id}
        while current_id:
            if current_id in visited:
                raise ValidationError("Circular folder reference detected")
            visited.add(current_id)
            parent = await self.repo.get_by_id(current_id)
            if not parent:
                break
            current_id = parent.parent_id
