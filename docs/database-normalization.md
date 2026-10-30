# StreamCinema catalog database

The current provider import remains in `public.streams` as an untouched source/staging table. The additive migration in `server/database/003_normalized_catalog_migration.sql` creates a normalized catalog beside it, using `sc_` names so it cannot conflict with earlier app schemas.

## Data model

- `sc_titles` stores one canonical movie, series, episode, or live-channel identity. Movies and series with a numeric TMDB ID share a canonical row by media kind and TMDB ID. Rows without an ID remain separate instead of risking false matches.
- `sc_title_translations` stores language-specific names, descriptions, trailer IDs, and localized posters. Provider language detection is inferred from the imported language field, category, and name; it is a hint, not proof of the audio track.
- `sc_provider_streams` stores each provider entry and its provider ID, language, provider name, extension, playback template, active status, and resolved-source cache/timestamps. Cached resolved URLs are carried forward and should be treated as sensitive and potentially temporary.
- `sc_series_episodes` links canonical episode titles to canonical series titles and season/episode numbers. Alternate provider streams for the same series/season/episode share the episode title when identifiers are available.
- `sc_categories`, `sc_category_languages`, and `sc_stream_categories` preserve provider categories as language-aware many-to-many stream groupings.
- `sc_genres` and `sc_title_genres` normalize provider genres. `sc_keywords` and `sc_title_keywords` are ready for TMDB keywords/tags enrichment.
- `sc_languages` contains language lookup values.

The migration copies only required fields from `raw_payload`; it does not duplicate the large provider JSON. `public.streams` is not dropped, altered, deactivated, or rewritten. The SQL is transactional and re-runnable. It imports active source rows and preserves already-cached resolved URLs when rerun.

## Apply on Proxmox

From PowerShell in the repository root, copy the migration file to PVE:

```powershell
scp .\StreamCinema\server\database\003_normalized_catalog_migration.sql root@10.42.0.50:/root/streamcinema-003.sql
```

Then apply it inside CT 190 with errors configured to stop execution:

```powershell
ssh root@10.42.0.50 "pct push 190 /root/streamcinema-003.sql /tmp/streamcinema-003.sql --perms 0644 && pct exec 190 -- runuser -u streamcinema -- psql -d streamcinema -v ON_ERROR_STOP=1 -f /tmp/streamcinema-003.sql"
```

The first normalization scans the active source catalog (roughly 393,000 rows). It may take several minutes. If any statement fails, the transaction rolls back and the original `streams` table remains intact. Do not rerun the import while the migration is executing.

After completion, copy and run `server/database/004_normalized_catalog_audit.sql` the same way. The audit reports source-versus-normalized counts, TMDB coverage, orphan references, uncategorized active streams, copied resolved sources, and examples of movies with multiple language streams. It does not print playback URLs.

No old tables should be dropped until the audit is reviewed and the app is deliberately switched to the normalized schema.
