# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GCSService reuses its signing credentials and client.

Every sign is an IAM signBlob round trip; building fresh impersonated
credentials and a storage.Client per call (the old shape) doubles the cost of
each media view. The durable media route signs per request, so reuse is
mandatory (WP2 R2).
"""

import datetime
from unittest.mock import MagicMock

import pytest

from app.config import settings
from app.services import gcs
from app.services.gcs import GCSService, ObjectStoreUnavailableError, get_gcs_service


@pytest.fixture
def google(monkeypatch):
    fake = MagicMock()
    fake.default.return_value = (object(), "project")
    blob = MagicMock()
    blob.generate_signed_url.return_value = "https://storage.googleapis.com/b/k?X-Goog-Signature=s"
    client = MagicMock()
    client.bucket.return_value.blob.return_value = blob
    monkeypatch.setattr(gcs.google.auth, "default", fake.default)
    monkeypatch.setattr(gcs.impersonated_credentials, "Credentials", fake.Credentials)
    monkeypatch.setattr(gcs.storage, "Client", MagicMock(return_value=client))
    fake.blob = blob
    fake.client = client
    return fake


def test_signing_credentials_and_client_are_built_once(google):
    service = GCSService("bucket", "signer@example.iam.gserviceaccount.com")

    service.generate_download_url("media/a/b/c.png")
    service.generate_download_url("media/a/b/d.png")
    service.generate_upload_url("media/a/b/e.png", "image/png")

    assert google.default.call_count == 1
    assert google.Credentials.call_count == 1
    assert gcs.storage.Client.call_count == 1


def test_download_url_honours_ttl_and_disposition(google):
    service = GCSService("bucket", "signer@example.iam.gserviceaccount.com")

    service.generate_download_url(
        "k", expiration=datetime.timedelta(minutes=15), content_disposition="attachment"
    )

    kwargs = google.blob.generate_signed_url.call_args.kwargs
    assert kwargs["expiration"] == datetime.timedelta(minutes=15)
    assert kwargs["response_disposition"] == "attachment"


def test_download_url_default_ttl_stays_one_hour(google):
    GCSService("bucket", "sa").generate_download_url("k")

    kwargs = google.blob.generate_signed_url.call_args.kwargs
    assert kwargs["expiration"] == datetime.timedelta(hours=1)
    assert "response_disposition" not in kwargs


def test_stat_object_returns_type_and_size(google):
    stored = MagicMock(content_type="image/png", size=42)
    google.client.bucket.return_value.get_blob.return_value = stored

    stat = GCSService("bucket", "sa").stat_object("k")

    assert (stat.content_type, stat.size_bytes) == ("image/png", 42)


def test_stat_object_missing_is_none(google):
    google.client.bucket.return_value.get_blob.return_value = None

    assert GCSService("bucket", "sa").stat_object("k") is None


def test_stat_object_failure_is_unavailable_not_missing(google):
    google.client.bucket.return_value.get_blob.side_effect = RuntimeError("no creds")

    with pytest.raises(ObjectStoreUnavailableError):
        GCSService("bucket", "sa").stat_object("k")


def test_get_gcs_service_is_a_singleton_per_configuration(google, monkeypatch):
    monkeypatch.setattr(settings, "GCS_BUCKET", "bucket-a")
    monkeypatch.setattr(settings, "GCS_SA_EMAIL", "sa")

    first = get_gcs_service()
    assert get_gcs_service() is first

    monkeypatch.setattr(settings, "GCS_BUCKET", "bucket-b")
    assert get_gcs_service() is not first
    assert get_gcs_service().bucket_name == "bucket-b"
