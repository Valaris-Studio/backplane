# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import datetime
import logging
from dataclasses import dataclass

from app.config import settings

try:
    import google.auth
    import google.auth.exceptions
    from google.auth import impersonated_credentials
    from google.cloud import storage

    _HAS_GCS = True
except ImportError:
    _HAS_GCS = False

logger = logging.getLogger(__name__)

UPLOAD_URL_TTL = datetime.timedelta(minutes=15)
DEFAULT_DOWNLOAD_URL_TTL = datetime.timedelta(hours=1)


class ObjectStoreUnavailableError(Exception):
    """The bucket could not be asked (credentials, network) — distinct from
    the object being absent, which callers report as a 404."""


@dataclass(frozen=True)
class ObjectStat:
    content_type: str | None
    size_bytes: int | None


class GCSService:
    def __init__(self, bucket_name: str, service_account_email: str = ""):
        self.bucket_name = bucket_name
        self.service_account_email = service_account_email
        self._signing_credentials = None
        self._client = None
        if self.bucket_name and not _HAS_GCS:
            raise RuntimeError(
                "GCS_BUCKET is configured but google-cloud-storage is not installed. "
                "Install it with: pip install google-cloud-storage"
            )

    def _get_signing_credentials(self):
        """Impersonated credentials that sign blobs via the IAM API.

        Built once per service: they refresh themselves, and rebuilding them
        per sign doubled the cost of every signed URL."""
        if self._signing_credentials is None:
            source_credentials, _ = google.auth.default()
            self._signing_credentials = impersonated_credentials.Credentials(
                source_credentials=source_credentials,
                target_principal=self.service_account_email,
                target_scopes=["https://www.googleapis.com/auth/devstorage.full_control"],
            )
        return self._signing_credentials

    def _bucket(self):
        if self._client is None:
            self._client = storage.Client()
        return self._client.bucket(self.bucket_name)

    def generate_upload_url(self, gcs_path: str, content_type: str) -> str | None:
        if not self.bucket_name:
            return None
        try:
            return self._bucket().blob(gcs_path).generate_signed_url(
                version="v4",
                expiration=UPLOAD_URL_TTL,
                method="PUT",
                content_type=content_type,
                credentials=self._get_signing_credentials(),
            )
        except Exception as e:
            logger.warning("GCS credentials unavailable: %s", e)
            return None

    def generate_download_url(
        self,
        gcs_path: str,
        *,
        expiration: datetime.timedelta = DEFAULT_DOWNLOAD_URL_TTL,
        content_disposition: str | None = None,
    ) -> str | None:
        if not self.bucket_name:
            return None
        signing_options = {}
        if content_disposition is not None:
            signing_options["response_disposition"] = content_disposition
        try:
            return self._bucket().blob(gcs_path).generate_signed_url(
                version="v4",
                expiration=expiration,
                method="GET",
                credentials=self._get_signing_credentials(),
                **signing_options,
            )
        except Exception as e:
            logger.warning("GCS credentials unavailable: %s", e)
            return None

    def stat_object(self, gcs_path: str) -> ObjectStat | None:
        try:
            blob = self._bucket().get_blob(gcs_path)
        except Exception as e:
            raise ObjectStoreUnavailableError(str(e)) from e
        if blob is None:
            return None
        return ObjectStat(content_type=blob.content_type, size_bytes=blob.size)


_shared_service: GCSService | None = None


def get_gcs_service() -> GCSService:
    """Process-wide service for the configured bucket, so credentials and the
    HTTP client are reused across requests."""
    global _shared_service
    configured = (settings.GCS_BUCKET, settings.GCS_SA_EMAIL)
    if _shared_service is None or (
        _shared_service.bucket_name,
        _shared_service.service_account_email,
    ) != configured:
        _shared_service = GCSService(*configured)
    return _shared_service
