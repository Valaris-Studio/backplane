# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import datetime
import logging

try:
    import google.auth
    import google.auth.exceptions
    from google.auth import impersonated_credentials
    from google.cloud import storage

    _HAS_GCS = True
except ImportError:
    _HAS_GCS = False

logger = logging.getLogger(__name__)


class GCSService:
    def __init__(self, bucket_name: str, service_account_email: str = ""):
        self.bucket_name = bucket_name
        self.service_account_email = service_account_email
        if self.bucket_name and not _HAS_GCS:
            raise RuntimeError(
                "GCS_BUCKET is configured but google-cloud-storage is not installed. "
                "Install it with: pip install google-cloud-storage"
            )

    def _get_signing_credentials(self):
        """Build impersonated credentials that can sign blobs via IAM API."""
        source_credentials, _ = google.auth.default()
        return impersonated_credentials.Credentials(
            source_credentials=source_credentials,
            target_principal=self.service_account_email,
            target_scopes=["https://www.googleapis.com/auth/devstorage.full_control"],
        )

    def generate_upload_url(self, gcs_path: str, content_type: str) -> str | None:
        if not self.bucket_name:
            return None
        try:
            signing_creds = self._get_signing_credentials()
            client = storage.Client()
            bucket = client.bucket(self.bucket_name)
            blob = bucket.blob(gcs_path)
            return blob.generate_signed_url(
                version="v4",
                expiration=datetime.timedelta(minutes=15),
                method="PUT",
                content_type=content_type,
                credentials=signing_creds,
            )
        except (google.auth.exceptions.DefaultCredentialsError, Exception) as e:
            logger.warning("GCS credentials unavailable: %s", e)
            return None

    def generate_download_url(self, gcs_path: str) -> str | None:
        if not self.bucket_name:
            return None
        try:
            signing_creds = self._get_signing_credentials()
            client = storage.Client()
            bucket = client.bucket(self.bucket_name)
            blob = bucket.blob(gcs_path)
            return blob.generate_signed_url(
                version="v4",
                expiration=datetime.timedelta(hours=1),
                method="GET",
                credentials=signing_creds,
            )
        except (google.auth.exceptions.DefaultCredentialsError, Exception) as e:
            logger.warning("GCS credentials unavailable: %s", e)
            return None
