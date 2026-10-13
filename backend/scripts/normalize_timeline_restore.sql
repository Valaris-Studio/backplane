-- Copyright (c) 2026 Valaris Studio
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Run after a logical restore, while application writers are stopped. XIDs
-- belong to the source cluster; activity itself remains the durable history.
DO $timeline_restore$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('public.activities')
          AND attname = 'recorded_transaction'
          AND NOT attisdropped
    ) THEN
        UPDATE public.activities
        SET recorded_transaction = NULL
        WHERE recorded_transaction IS NOT NULL;
    END IF;

    IF to_regclass('public.timeline_generations') IS NOT NULL THEN
        DELETE FROM public.timeline_generations;
    END IF;
END
$timeline_restore$;
