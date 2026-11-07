-- Run in a read-only transaction with a trusted search_path before admitting
-- the composite session identity migration. Return counts, never retained text.
SELECT
    (
        SELECT count(*)
        FROM session_search_chunks AS chunk
        LEFT JOIN session_search_sources AS source ON source.id = chunk.source_id
        WHERE source.id IS NULL
           OR chunk.session_id IS DISTINCT FROM source.session_id
    ) AS chunk_source_violations,
    (
        SELECT count(*)
        FROM session_search_sources AS source
        LEFT JOIN agent_session_contents AS content ON content.id = source.content_id
        WHERE source.content_id IS NOT NULL
          AND (
              content.id IS NULL
              OR source.session_id IS DISTINCT FROM content.session_id
          )
    ) AS source_content_violations;
