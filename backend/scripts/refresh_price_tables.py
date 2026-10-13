# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Re-vendor the model price tables under app/pricing/data.

Downloads LiteLLM's model_prices_and_context_window.json at the latest commit
that touched it (pinned by sha, so the file and the recorded commit always
agree) and models.dev's api.json, keeps only the token rates of the providers
the supported agents use, and writes them with a manifest whose version is
derived from the commit and the trimmed content. Both sources are MIT; their
licenses sit next to the data.

After a refresh, stored usage keeps its old estimates until repriced:

    source .venv/bin/activate
    python -m scripts.refresh_price_tables
    python -m scripts.reprice_agent_usage --apply

Offline, from files already downloaded:

    python -m scripts.refresh_price_tables --litellm-file prices.json \\
        --litellm-commit <sha> --models-dev-file api.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).parents[1] / "app/pricing/data"
LITELLM_REPO = "BerriAI/litellm"
LITELLM_PATH = "model_prices_and_context_window.json"
MODELS_DEV_URL = "https://models.dev/api.json"
LITELLM_FILE = "litellm_prices.json"
MODELS_DEV_FILE = "models_dev_prices.json"

# LiteLLM `litellm_provider` values and models.dev provider ids the supported
# agents (Claude Code, Codex, Pi) run against. Pi reaches many providers, so
# the common first-party APIs and routers are kept; a model outside them is
# reported unpriced rather than guessed.
LITELLM_PROVIDERS = frozenset(
    {
        "anthropic",
        "openai",
        "gemini",
        "xai",
        "deepseek",
        "mistral",
        "openrouter",
        "groq",
        "cerebras",
        "fireworks_ai",
        "together_ai",
        "moonshot",
        "zai",
        "minimax",
        "github_copilot",
    }
)
MODELS_DEV_PROVIDERS = frozenset(
    {
        "anthropic",
        "openai",
        "google",
        "xai",
        "deepseek",
        "mistral",
        "openrouter",
        "groq",
        "cerebras",
        "fireworks-ai",
        "togetherai",
        "moonshotai",
        "zai",
        "minimax",
        "github-copilot",
        "amazon-bedrock",
        "google-vertex",
    }
)
TEXT_MODES = frozenset({None, "chat", "responses", "completion"})
TOKEN_RATE_KEY = re.compile(
    r"(input_cost_per_token|output_cost_per_token|output_cost_per_reasoning_token"
    r"|cache_read_input_token_cost|cache_creation_input_token_cost)"
    r"(_above_1hr)?(_above_\d+k_tokens)?(_priority|_flex|_batches)?"
)
MODELS_DEV_COST_KEYS = frozenset(
    {"input", "output", "cache_read", "cache_write", "reasoning", "tiers"}
)


def _encoded(value) -> str:
    return json.dumps(value, sort_keys=True, indent=1, ensure_ascii=False) + "\n"


@dataclass(frozen=True)
class Snapshot:
    litellm: dict
    models_dev: dict
    manifest: dict

    def files(self) -> dict[str, str]:
        return {
            LITELLM_FILE: _encoded(self.litellm),
            MODELS_DEV_FILE: _encoded(self.models_dev),
            "manifest.json": _encoded(self.manifest),
        }


def _trim_litellm(prices: dict) -> dict:
    trimmed = {}
    for model, entry in prices.items():
        if (
            not isinstance(entry, dict)
            or entry.get("litellm_provider") not in LITELLM_PROVIDERS
        ):
            continue
        if entry.get("mode") not in TEXT_MODES or "input_cost_per_token" not in entry:
            continue
        kept = {
            key: value for key, value in entry.items() if TOKEN_RATE_KEY.fullmatch(key)
        }
        kept["litellm_provider"] = entry["litellm_provider"]
        if "max_input_tokens" in entry:
            kept["max_input_tokens"] = entry["max_input_tokens"]
        trimmed[model] = kept
    return trimmed


def _trim_models_dev(catalog: dict) -> dict:
    trimmed = {}
    for provider, body in catalog.items():
        if provider not in MODELS_DEV_PROVIDERS or not isinstance(body, dict):
            continue
        models = {
            model_id: {
                "cost": {
                    key: value
                    for key, value in model["cost"].items()
                    if key in MODELS_DEV_COST_KEYS
                }
            }
            for model_id, model in (body.get("models") or {}).items()
            if isinstance(model, dict) and isinstance(model.get("cost"), dict)
        }
        if models:
            trimmed[provider] = {"models": models}
    return trimmed


def build_snapshot(
    litellm: dict,
    models_dev: dict,
    *,
    litellm_commit: str,
    litellm_committed_at: str,
    fetched_at: str,
) -> Snapshot:
    trimmed_litellm = _trim_litellm(litellm)
    trimmed_models_dev = _trim_models_dev(models_dev)
    litellm_sha = hashlib.sha256(_encoded(trimmed_litellm).encode()).hexdigest()
    models_dev_sha = hashlib.sha256(_encoded(trimmed_models_dev).encode()).hexdigest()
    manifest = {
        # Stored on every priced usage row; a change marks rows for repricing.
        "version": f"litellm-{litellm_commit[:12]}.models-dev-{models_dev_sha[:12]}",
        "litellm": {
            "file": LITELLM_FILE,
            "source": f"https://github.com/{LITELLM_REPO}/blob/{litellm_commit}/{LITELLM_PATH}",
            "commit": litellm_commit,
            "committed_at": litellm_committed_at,
            "license": "MIT",
            "sha256": litellm_sha,
            "providers": sorted(LITELLM_PROVIDERS),
        },
        "models_dev": {
            "file": MODELS_DEV_FILE,
            "source": MODELS_DEV_URL,
            "fetched_at": fetched_at,
            "license": "MIT",
            "sha256": models_dev_sha,
            "providers": sorted(MODELS_DEV_PROVIDERS),
        },
    }
    return Snapshot(trimmed_litellm, trimmed_models_dev, manifest)


def _get(url: str) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": "backplane-price-refresh"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def _latest_litellm_commit() -> tuple[str, str]:
    commits = json.loads(
        _get(
            f"https://api.github.com/repos/{LITELLM_REPO}/commits?path={LITELLM_PATH}&per_page=1"
        )
    )
    return commits[0]["sha"], commits[0]["commit"]["committer"]["date"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--litellm-file", type=Path)
    parser.add_argument(
        "--litellm-commit", help="commit the --litellm-file was taken from"
    )
    parser.add_argument("--litellm-committed-at", default="unknown")
    parser.add_argument("--models-dev-file", type=Path)
    parser.add_argument(
        "--fetched-at",
        help="date recorded for the models.dev snapshot (default: today, UTC)",
    )
    parser.add_argument("--out", type=Path, default=DATA_DIR)
    args = parser.parse_args(argv)

    if args.litellm_file:
        if not args.litellm_commit:
            parser.error("--litellm-file needs --litellm-commit")
        commit, committed_at = args.litellm_commit, args.litellm_committed_at
        litellm = json.loads(args.litellm_file.read_text())
    else:
        commit, committed_at = _latest_litellm_commit()
        litellm = json.loads(
            _get(
                f"https://raw.githubusercontent.com/{LITELLM_REPO}/{commit}/{LITELLM_PATH}"
            )
        )
    models_dev = json.loads(
        args.models_dev_file.read_text()
        if args.models_dev_file
        else _get(MODELS_DEV_URL)
    )
    fetched_at = args.fetched_at or datetime.now(timezone.utc).date().isoformat()

    snapshot = build_snapshot(
        litellm,
        models_dev,
        litellm_commit=commit,
        litellm_committed_at=committed_at,
        fetched_at=fetched_at,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    for name, content in snapshot.files().items():
        (args.out / name).write_text(content)
    print(
        f"price tables {snapshot.manifest['version']}: "
        f"{len(snapshot.litellm)} LiteLLM models, "
        f"{sum(len(p['models']) for p in snapshot.models_dev.values())} models.dev models"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
