# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.utils import SLUG_FORMAT, shallow_merge_dicts, slugify


def test_shallow_merge_adds_new_keys():
    assert shallow_merge_dicts({"a": 1}, {"b": 2}) == {"a": 1, "b": 2}


def test_shallow_merge_overwrites_existing():
    assert shallow_merge_dicts({"a": 1}, {"a": 2}) == {"a": 2}


def test_shallow_merge_preserves_unmentioned():
    assert shallow_merge_dicts({"a": 1, "b": 2}, {"a": 3}) == {"a": 3, "b": 2}


def test_shallow_merge_none_deletes_key():
    assert shallow_merge_dicts({"a": 1, "b": 2}, {"b": None}) == {"a": 1}


def test_shallow_merge_empty_updates():
    assert shallow_merge_dicts({"a": 1}, {}) == {"a": 1}


def test_shallow_merge_empty_existing():
    assert shallow_merge_dicts({}, {"a": 1}) == {"a": 1}


def test_slugify_lowercases_and_hyphenates():
    assert slugify("My Cool Board") == "my-cool-board"


def test_slugify_collapses_non_alphanum():
    assert slugify("Hello, World!!!") == "hello-world"


def test_slugify_strips_leading_trailing_hyphens():
    assert slugify("---foo---") == "foo"


def test_slugify_empty_string_uses_fallback():
    assert slugify("") == "item"
    assert slugify("", fallback="board") == "board"


def test_slugify_only_symbols_uses_fallback():
    assert slugify("!!!") == "item"


def test_slug_format_accepts_valid():
    assert SLUG_FORMAT.match("foo-bar-2")
    assert SLUG_FORMAT.match("abc123")


def test_slug_format_rejects_invalid():
    assert not SLUG_FORMAT.match("Has Spaces")
    assert not SLUG_FORMAT.match("UPPER")
    assert not SLUG_FORMAT.match("-leading")
    assert not SLUG_FORMAT.match("")
    assert not SLUG_FORMAT.match("bang!")
