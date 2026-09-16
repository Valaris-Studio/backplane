# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient

from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/resources"


async def test_list_workspace_resources_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_create_workspace_resource_file(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL,
        json={"name": "report.pdf", "resource_type": "file", "mime_type": "application/pdf", "size_bytes": 2048},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "report.pdf"
    assert data["resource_type"] == "file"
    assert data["board_id"] is None
    assert data["mime_type"] == "application/pdf"
    assert data["size_bytes"] == 2048
    assert data["gcs_path"] is not None
    assert data["metadata"] == {}
    assert data["description"] is None


async def test_create_workspace_resource_folder(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL,
        json={"name": "Documents", "resource_type": "folder"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Documents"
    assert data["resource_type"] == "folder"
    assert data["gcs_path"] is None
    assert data["mime_type"] is None
    assert data["size_bytes"] is None
    assert data["metadata"] == {}


async def test_create_workspace_resource_with_parent(
    client: AsyncClient, test_workspace: Workspace
):
    folder_resp = await client.post(
        BASE_URL,
        json={"name": "Folder", "resource_type": "folder"},
    )
    assert folder_resp.status_code == 201
    folder_id = folder_resp.json()["id"]

    file_resp = await client.post(
        BASE_URL,
        json={"name": "nested.txt", "resource_type": "file", "parent_id": folder_id},
    )
    assert file_resp.status_code == 201
    assert file_resp.json()["parent_id"] == folder_id


async def test_create_workspace_resource_invalid_parent(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL,
        json={"name": "orphan.txt", "parent_id": str(uuid.uuid4())},
    )
    assert response.status_code == 404


async def test_create_workspace_resource_parent_not_folder(
    client: AsyncClient, test_workspace: Workspace
):
    file_resp = await client.post(
        BASE_URL,
        json={"name": "file.txt", "resource_type": "file"},
    )
    assert file_resp.status_code == 201
    file_id = file_resp.json()["id"]

    response = await client.post(
        BASE_URL,
        json={"name": "nested.txt", "parent_id": file_id},
    )
    assert response.status_code == 422


async def test_list_workspace_resources_success(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(BASE_URL, json={"name": "Docs", "resource_type": "folder"})
    await client.post(BASE_URL, json={"name": "readme.md", "resource_type": "file"})

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    # folders first
    assert data[0]["resource_type"] == "folder"
    assert data[1]["resource_type"] == "file"


async def test_list_workspace_resources_with_parent_filter(
    client: AsyncClient, test_workspace: Workspace
):
    folder_resp = await client.post(
        BASE_URL, json={"name": "Parent", "resource_type": "folder"}
    )
    folder_id = folder_resp.json()["id"]
    await client.post(
        BASE_URL, json={"name": "child.txt", "parent_id": folder_id}
    )
    await client.post(BASE_URL, json={"name": "root.txt"})

    response = await client.get(f"{BASE_URL}?parent_id={folder_id}")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["name"] == "child.txt"


async def test_get_workspace_resource_success(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"name": "get-me.txt"})
    assert create_resp.status_code == 201
    resource_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{resource_id}")
    assert response.status_code == 200
    assert response.json()["name"] == "get-me.txt"


async def test_get_workspace_resource_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE_URL}/{uuid.uuid4()}")
    assert response.status_code == 404


async def test_update_workspace_resource_rename(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"name": "old-name.txt"})
    resource_id = create_resp.json()["id"]

    response = await client.put(
        f"{BASE_URL}/{resource_id}", json={"name": "new-name.txt"}
    )
    assert response.status_code == 200
    assert response.json()["name"] == "new-name.txt"


async def test_update_workspace_resource_move_to_folder(
    client: AsyncClient, test_workspace: Workspace
):
    folder_resp = await client.post(
        BASE_URL, json={"name": "Target", "resource_type": "folder"}
    )
    folder_id = folder_resp.json()["id"]

    file_resp = await client.post(BASE_URL, json={"name": "movable.txt"})
    file_id = file_resp.json()["id"]

    response = await client.put(
        f"{BASE_URL}/{file_id}", json={"parent_id": folder_id}
    )
    assert response.status_code == 200
    assert response.json()["parent_id"] == folder_id


async def test_delete_workspace_resource_success(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"name": "delete-me.txt"})
    resource_id = create_resp.json()["id"]

    response = await client.delete(f"{BASE_URL}/{resource_id}")
    assert response.status_code == 204

    get_resp = await client.get(f"{BASE_URL}/{resource_id}")
    assert get_resp.status_code == 404


async def test_delete_workspace_resource_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.delete(f"{BASE_URL}/{uuid.uuid4()}")
    assert response.status_code == 404


async def test_upload_url_local_fallback(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "test.pdf", "content_type": "application/pdf"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "/api/local-storage/upload/" in data["upload_url"]
    assert data["gcs_path"] is not None


async def test_download_url_local_fallback(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"name": "file.txt"})
    resource_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{resource_id}/download-url")
    assert response.status_code == 200
    data = response.json()
    assert "/api/local-storage/download/" in data["download_url"]


# --- Search & filter tests ---


async def test_search_resources_by_name(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(BASE_URL, json={"name": "design-spec.pdf", "resource_type": "file"})
    await client.post(BASE_URL, json={"name": "budget.xlsx", "resource_type": "file"})
    await client.post(BASE_URL, json={"name": "design-mockup.png", "resource_type": "file"})

    response = await client.get(f"{BASE_URL}?q=design")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    names = {r["name"] for r in data}
    assert names == {"design-spec.pdf", "design-mockup.png"}


async def test_search_resources_across_folders(
    client: AsyncClient, test_workspace: Workspace
):
    folder_resp = await client.post(
        BASE_URL, json={"name": "Archive", "resource_type": "folder"}
    )
    folder_id = folder_resp.json()["id"]
    await client.post(
        BASE_URL, json={"name": "report-q1.pdf", "parent_id": folder_id}
    )
    await client.post(BASE_URL, json={"name": "report-q2.pdf"})

    response = await client.get(f"{BASE_URL}?q=report")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    names = {r["name"] for r in data}
    assert names == {"report-q1.pdf", "report-q2.pdf"}


async def test_filter_by_resource_type(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(BASE_URL, json={"name": "Docs", "resource_type": "folder"})
    await client.post(BASE_URL, json={"name": "readme.md", "resource_type": "file"})
    await client.post(BASE_URL, json={"name": "notes.txt", "resource_type": "file"})

    response = await client.get(f"{BASE_URL}?resource_type=file")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    assert all(r["resource_type"] == "file" for r in data)


async def test_filter_by_tag(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(
        BASE_URL,
        json={"name": "logo.png", "metadata": {"tags": ["design", "branding"]}},
    )
    await client.post(
        BASE_URL,
        json={"name": "spec.md", "metadata": {"tags": ["docs"]}},
    )
    await client.post(BASE_URL, json={"name": "plain.txt"})

    response = await client.get(f"{BASE_URL}?tag=design")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["name"] == "logo.png"


async def test_list_tags_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE_URL}/tags")
    assert response.status_code == 200
    assert response.json() == []


async def test_list_tags_returns_unique(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(
        BASE_URL,
        json={"name": "a.png", "metadata": {"tags": ["design", "ui"]}},
    )
    await client.post(
        BASE_URL,
        json={"name": "b.png", "metadata": {"tags": ["design", "branding"]}},
    )

    response = await client.get(f"{BASE_URL}/tags")
    assert response.status_code == 200
    data = response.json()
    assert data == ["branding", "design", "ui"]


# --- Metadata CRUD tests ---


async def test_create_resource_with_metadata(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL,
        json={
            "name": "mockup.fig",
            "resource_type": "file",
            "metadata": {"tags": ["design", "v2"]},
            "description": "Main landing page mockup",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["metadata"] == {"tags": ["design", "v2"]}
    assert data["description"] == "Main landing page mockup"


async def test_update_resource_metadata(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(
        BASE_URL,
        json={
            "name": "file.txt",
            "metadata": {"tags": ["old"]},
            "description": "Old desc",
        },
    )
    resource_id = create_resp.json()["id"]

    response = await client.put(
        f"{BASE_URL}/{resource_id}",
        json={"metadata": {"tags": ["new", "updated"]}, "description": "New desc"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["metadata"] == {"tags": ["new", "updated"]}
    assert data["description"] == "New desc"


async def test_update_resource_metadata_partial(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(
        BASE_URL,
        json={
            "name": "file.txt",
            "metadata": {"tags": ["keep"]},
            "description": "Original",
        },
    )
    resource_id = create_resp.json()["id"]

    response = await client.put(
        f"{BASE_URL}/{resource_id}",
        json={"description": "Updated only desc"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["metadata"] == {"tags": ["keep"]}
    assert data["description"] == "Updated only desc"


async def test_metadata_validation_too_many_tags(
    client: AsyncClient, test_workspace: Workspace
):
    tags = [f"tag-{i}" for i in range(25)]
    response = await client.post(
        BASE_URL,
        json={"name": "file.txt", "metadata": {"tags": tags}},
    )
    assert response.status_code == 422


async def test_metadata_validation_tag_too_long(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL,
        json={"name": "file.txt", "metadata": {"tags": ["x" * 60]}},
    )
    assert response.status_code == 422
