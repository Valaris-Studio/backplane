// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  id?: string;
  "aria-labelledby"?: string;
}

export function TagInput({
  tags,
  onChange,
  placeholder,
  maxTags = 20,
  id,
  "aria-labelledby": ariaLabelledBy,
}: TagInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");

  function addTag(raw: string) {
    const value = raw.trim().toLowerCase();
    if (!value || tags.includes(value) || tags.length >= maxTags) return;
    onChange([...tags, value]);
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(input);
      setInput("");
      return;
    }
    // Backspace on empty input removes the most recent tag — standard chip-
    // input convention so keyboard users don't have to tab to the X button.
    if (e.key === "Backspace" && input === "" && tags.length > 0) {
      e.preventDefault();
      const last = tags[tags.length - 1];
      if (last !== undefined) removeTag(last);
      return;
    }
    if (e.key === "Escape" && input !== "") {
      e.preventDefault();
      setInput("");
    }
  }

  function handleChange(value: string) {
    if (value.includes(",")) {
      const segments = value.split(",");
      segments.slice(0, -1).forEach((s) => addTag(s));
      setInput(segments[segments.length - 1] ?? "");
    } else {
      setInput(value);
    }
  }

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <ul role="list" aria-live="polite" className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag} className="list-none">
              <Badge variant="secondary" className="gap-1 pr-1">
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  aria-label={t("a11y.tagInput.removeTag", { tag })}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        aria-labelledby={ariaLabelledBy}
        value={input}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? t("common.add")}
        disabled={tags.length >= maxTags}
      />
    </div>
  );
}
