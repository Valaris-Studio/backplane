# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""In-memory stand-in for GCSService, installed as the process singleton."""

from urllib.parse import quote

from app.config import settings
from app.services import gcs
from app.services.gcs import ObjectStat, ObjectStoreUnavailableError

FAKE_BUCKET = "fake-media-bucket"
FAKE_SIGNER = "signer@example.iam.gserviceaccount.com"


class FakeGCS:
    def __init__(self) -> None:
        self.bucket_name = FAKE_BUCKET
        self.service_account_email = FAKE_SIGNER
        self.objects: dict[str, ObjectStat] = {}
        self.sign_calls: list[tuple[str, object, object]] = []
        self.stat_calls: list[str] = []
        self.signing_broken = False
        self.bucket_unreachable = False

    def add(self, key: str, content_type: str = "image/png", size: int = 10) -> None:
        self.objects[key] = ObjectStat(content_type=content_type, size_bytes=size)

    def stat_object(self, key: str) -> ObjectStat | None:
        self.stat_calls.append(key)
        if self.bucket_unreachable:
            raise ObjectStoreUnavailableError("unreachable")
        return self.objects.get(key)

    def generate_download_url(self, key, *, expiration=None, content_disposition=None):
        if self.signing_broken:
            return None
        self.sign_calls.append((key, expiration, content_disposition))
        n = len(self.sign_calls)
        return f"https://storage.googleapis.com/{FAKE_BUCKET}/{quote(key)}?X-Goog-Signature=sig{n}"

    def generate_upload_url(self, key, content_type):
        if self.signing_broken:
            return None
        return f"https://storage.googleapis.com/{FAKE_BUCKET}/{quote(key)}?X-Goog-Signature=put"


def install_fake_gcs(monkeypatch) -> FakeGCS:
    fake = FakeGCS()
    monkeypatch.setattr(settings, "GCS_BUCKET", FAKE_BUCKET)
    monkeypatch.setattr(settings, "GCS_SA_EMAIL", FAKE_SIGNER)
    monkeypatch.setattr(gcs, "_shared_service", fake)
    return fake
