-- Read-only checks after 003_normalized_catalog_migration.sql completes.

SELECT 'source_active' AS dataset, kind, count(*) AS rows
FROM streams WHERE active GROUP BY kind
UNION ALL
SELECT 'normalized_provider_streams' AS dataset, kind, count(*) AS rows
FROM sc_provider_streams WHERE active GROUP BY kind
ORDER BY dataset, kind;

SELECT t.kind, count(*) AS normalized_titles,
       count(*) FILTER (WHERE t.tmdb_id IS NOT NULL) AS titles_with_tmdb_id
FROM sc_titles t
GROUP BY t.kind ORDER BY t.kind;

SELECT count(*) AS orphan_provider_streams
FROM sc_provider_streams p LEFT JOIN sc_titles t ON t.id=p.title_id
WHERE t.id IS NULL;

SELECT count(*) AS active_streams_without_category
FROM sc_provider_streams p LEFT JOIN sc_stream_categories c ON c.stream_id=p.id
WHERE p.active AND c.stream_id IS NULL;

SELECT count(*) AS resolved_sources_copied
FROM sc_provider_streams WHERE resolved_source_url IS NOT NULL;

SELECT t.tmdb_id, t.original_title, count(DISTINCT p.language_id) AS languages,
       count(*) AS provider_streams
FROM sc_titles t JOIN sc_provider_streams p ON p.title_id=t.id AND p.active
WHERE t.kind='movie' AND t.tmdb_id IS NOT NULL
GROUP BY t.id,t.tmdb_id,t.original_title
HAVING count(DISTINCT p.language_id)>1
ORDER BY provider_streams DESC
LIMIT 20;
