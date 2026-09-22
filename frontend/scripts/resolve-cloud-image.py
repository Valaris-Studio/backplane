#!/usr/bin/env python3
# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import json
from pathlib import Path
import re
import subprocess


def serving_revision(services):
    if not services:
        return None
    if len(services) != 1:
        raise ValueError('Expected exactly one frontend service')
    traffic = [target for target in services[0]['status'].get('traffic', []) if target.get('percent', 0) > 0]
    if len(traffic) != 1 or traffic[0].get('percent') != 100 or not traffic[0].get('revisionName'):
        raise ValueError('Asset retention requires one fully serving frontend revision; resolve split traffic before building')
    return traffic[0]['revisionName']


def image_digest(revision):
    image = revision['status']['imageDigest']
    if not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', image):
        raise ValueError('Expected an immutable frontend image digest')
    return image


def check_predecessor(current, expected):
    if current != expected:
        raise ValueError('Serving frontend changed during the build; rebuild against the new predecessor')


def gcloud(*args):
    return json.loads(subprocess.check_output(['gcloud', 'run', *args, '--format=json'], text=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', required=True)
    parser.add_argument('--region', required=True)
    parser.add_argument('--expected-image-file', type=Path)
    args = parser.parse_args()
    services = gcloud('services', 'list', f'--region={args.region}', f'--filter=metadata.name={args.service}')
    revision = serving_revision(services)
    image = image_digest(gcloud('revisions', 'describe', revision, f'--region={args.region}')) if revision else 'nginx:alpine'
    if args.expected_image_file:
        check_predecessor(image, args.expected_image_file.read_text().strip())
    print(image)
