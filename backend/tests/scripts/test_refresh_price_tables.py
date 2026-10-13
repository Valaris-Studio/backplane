# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

from scripts.refresh_price_tables import build_snapshot

LITELLM = {
    "sample_spec": {"input_cost_per_token": 0},
    "gpt-5.4": {
        "litellm_provider": "openai",
        "mode": "chat",
        "input_cost_per_token": 2.5e-06,
        "input_cost_per_token_priority": 5e-06,
        "input_cost_per_token_above_272k_tokens_flex": 2.5e-06,
        "cache_creation_input_token_cost_above_1hr": 5e-06,
        "output_cost_per_token": 1.5e-05,
        "search_context_cost_per_query": {"low": 0.01},
        "input_cost_per_image": 0.1,
        "max_input_tokens": 1050000,
    },
    "dall-e-9": {
        "litellm_provider": "openai",
        "mode": "image_generation",
        "input_cost_per_token": 1,
    },
    "some-host/model": {
        "litellm_provider": "unsupported_host",
        "input_cost_per_token": 1,
    },
}
MODELS_DEV = {
    "zai": {
        "id": "zai",
        "models": {
            "glm-9": {
                "name": "GLM",
                "cost": {"input": 1, "output": 4},
                "limit": {"context": 1},
            }
        },
    },
    "unsupported-host": {"models": {"x": {"cost": {"input": 1}}}},
}


def test_snapshot_keeps_only_token_rates_of_supported_providers():
    snapshot = build_snapshot(
        LITELLM,
        MODELS_DEV,
        litellm_commit="a" * 40,
        litellm_committed_at="2026-09-25T05:59:32Z",
        fetched_at="2026-09-25",
    )
    assert snapshot.litellm == {
        "gpt-5.4": {
            "litellm_provider": "openai",
            "input_cost_per_token": 2.5e-06,
            "input_cost_per_token_priority": 5e-06,
            "input_cost_per_token_above_272k_tokens_flex": 2.5e-06,
            "cache_creation_input_token_cost_above_1hr": 5e-06,
            "output_cost_per_token": 1.5e-05,
            "max_input_tokens": 1050000,
        }
    }
    assert snapshot.models_dev == {
        "zai": {"models": {"glm-9": {"cost": {"input": 1, "output": 4}}}}
    }


def test_snapshot_is_deterministic_and_versioned_by_content():
    first = build_snapshot(
        LITELLM,
        MODELS_DEV,
        litellm_commit="a" * 40,
        litellm_committed_at="t",
        fetched_at="d",
    )
    again = build_snapshot(
        dict(reversed(list(LITELLM.items()))),
        MODELS_DEV,
        litellm_commit="a" * 40,
        litellm_committed_at="t",
        fetched_at="d",
    )
    assert first.files() == again.files()
    manifest = json.loads(first.files()["manifest.json"])
    assert manifest["version"].startswith("litellm-aaaaaaaaaaaa.models-dev-")
    assert manifest["litellm"]["commit"] == "a" * 40
    changed = build_snapshot(
        LITELLM,
        {"zai": {"models": {"glm-9": {"cost": {"input": 2, "output": 4}}}}},
        litellm_commit="a" * 40,
        litellm_committed_at="t",
        fetched_at="d",
    )
    assert (
        json.loads(changed.files()["manifest.json"])["version"] != manifest["version"]
    )
