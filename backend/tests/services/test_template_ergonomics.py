# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from app.services.loop_template_render import SlotSpec, TemplateContent, preview
from app.services.loop_templates import get_system_template


def test_optional_empty_default_does_not_invent_example_history():
    content = TemplateContent(
        system_prompt="Work on the board.",
        loop_prompt="Start.\n<<LESSONS>>\nFinish.",
        slots=[
            SlotSpec(
                name="LESSONS",
                kind="scalar",
                required=False,
                default="",
                example="The fixture-server incident taught us X.",
            )
        ],
    )
    result = preview(content, {}, {})
    assert "fixture-server" not in result.loop_prompt
    assert result.used_values["LESSONS"] == {"value": "", "source": "default"}


def test_explicit_gallery_example_remains_available_and_attributed():
    example = "The fixture-server incident taught us X."
    content = TemplateContent(
        system_prompt="Work on the board.",
        loop_prompt="<<LESSONS>>",
        slots=[
            SlotSpec(
                name="LESSONS",
                kind="scalar",
                required=False,
                default="",
                example=example,
            )
        ],
    )
    result = preview(content, {"LESSONS": example}, {})
    assert result.loop_prompt == example
    assert result.used_values["LESSONS"] == {"value": example, "source": "supplied"}


def test_advanced_notes_guidance_supports_bounded_discovery():
    content = get_system_template("coding-loop").content
    assert "do NOT call list_notes" not in content.loop_prompt
    assert "next_offset" in content.loop_prompt
    assert "summary_only=True" in content.loop_prompt
