# Movie and Series Category Normalization

## Scope and current data

This work applies to movies and series only. Live TV/IPTV categories are explicitly out of scope and must remain unchanged.

The current normalized catalog contains 110 movie categories, 56 series categories, 56 episode-category records, and 151 live categories. Episode-category records should use the series taxonomy but should not appear as a separate browse section. The source categories and their provider IDs remain intact as aliases.

Examples from the catalog show that the current category list mixes several different concepts:

- Translated genres: `|EN| COMEDY` / `|PL| KOMEDIE`, `|EN| DRAMA` / `|PL| DRAMAT`, and `|EN| DOCUMENTARY` / `|PL| DOKUMENTALNE`.
- Localized family, horror, Christmas, war, and western categories.
- Platform collections such as Netflix, Disney+, Amazon Prime, Apple TV+, and HBO Max.
- Quality collections such as 4K.
- Provider-specific collections such as new releases, years, Top IMDb, and pre-releases.

These should not all be collapsed into one genre list.

## Proposed model

Keep `sc_categories` and `sc_stream_categories` as the unchanged provider import layer. Add a canonical category layer with:

1. A canonical category group, scoped by `movie` or `series` and typed as `genre`, `platform`, `quality`, or `collection`.
2. Localized display labels for English, Dutch, and Polish.
3. A membership table mapping one or more source category IDs to a canonical group, with a mapping source and confidence.

A stream can belong to multiple canonical groups. Browsing and filtering use the canonical group; audits and future remapping can still see the original provider category IDs and names. Live categories are neither mapped nor changed.

## High-confidence language mappings to review

| Canonical label (English) | Source category labels |
|---|---|
| Comedy | `|EN| COMEDY`; `|PL| KOMEDIE` |
| Drama | `|EN| DRAMA`; `|PL| DRAMAT` |
| Documentary | `|EN| DOCUMENTARY`; `|PL| DOKUMENTALNE` |
| Children & Family | `|EN| CHILDREN/FAMILY`; `|NL| KINDEREN`; `|PL| FAMILIJNE` |
| Horror & Thriller | `|EN| HORROR/THRILLER`; `|NL| HORROR`; `|PL| HORROR/THRILLER` |
| Romance | `|EN| DRAMA/ROMANCE`; `|PL| ROMANS/MIŁOŚĆ` |
| War | `|EN| WAR`; `|PL| WOJENNE` |
| Western | `|EN| WESTERNS`; `|PL| WESTERN` |
| Christmas | `|EN| CHRISTMAS MOVIES`; `|NL| KERSTFILMS`; `|PL| ŚWIĄTECZNE` |

Action/crime, adventure/history, and science-fiction/fantasy labels need review before merging because their meanings are not exact translations.

## Grouping rules

- Remove language markers from canonical display labels, but retain each source category's language association.
- Merge translated genre aliases only when their meanings match closely.
- Keep platform labels as platform collections, not genres. Merge translated platform aliases only within the same media kind.
- Keep 4K and other resolution markers as quality facets; do not fold them into genres.
- Keep year, recent-addition, ranking, and pre-release labels as collections. Do not assume that provider-added date means release date.
- Keep uncertain categories as separate `collection` or `other` groups until reviewed.
- Never update live category rows or live stream-category links.

## Rollout sequence

1. Build a read-only mapping preview with source category ID, kind, source name, detected language, proposed group, confidence, and linked-stream count.
2. Review ambiguous translations and classification (genre vs platform vs quality vs collection).
3. Add canonical group and alias tables, then populate only approved mappings. Keep the source layer unchanged.
4. Update movie/series category API queries to return canonical groups and filter by all member source IDs. Leave live API queries as-is.
5. Audit that every movie and series source category is either mapped or intentionally left unmapped, and verify live table counts and links are unchanged.

## Current implementation status

- Migration `server/database/007_normalized_categories.sql` is applied on CT 190. It adds canonical category and localized-label tables plus source-category mappings. It does not update the provider source tables.
- All 110 movie, 56 series, and 56 episode source categories are mapped. The 241 mapping links include additional family and quality facets. Episode categories use the series taxonomy. Live categories are excluded.
- High-confidence translated genre aliases are grouped, including Comedy/Comedies/Komedie/Komedies and the existing Drama, Documentary, Children & Family, Romance, War, Western, Horror, and Christmas aliases. Clear brand spelling variants are grouped too: `DISNEY+` and `DISNEY +` resolve to Disney+. Netflix, Prime Video, Apple TV+, HBO Max, and other supported platform variants use consistent labels.
- Platform categories can also map to a second facet. For example, Disney+ Kids maps to Disney+ and Children & Family, while 4K Netflix categories map to Netflix and 4K.
- Ambiguous labels remain separate rather than being merged speculatively. Original source names remain in `sc_categories` for review.
- `/movies/categories` and `/series/categories` return canonical IDs, English display labels, category type, and active item count. Their filters resolve across mapped source categories. `/live/categories` and Live TV filtering continue using original provider category IDs.
- Verified on CT 190: 78 movie groups, 41 series groups, and 151 Live TV categories. The API returns one Disney+ group (including both `DISNEY+` and `DISNEY +`) and movie filtering works. Active stream totals remain 51,594 movies, 12,683 series, 339,559 episodes, and 7,159 Live TV streams.
- Database backups before the initial migration and this refinement are at `/var/backups/streamcinema/streamcinema-pre-category-normalization-20261029.dump` and `/var/backups/streamcinema/streamcinema-pre-category-refinement-20261029.dump`.

The API currently selects English labels. Dutch and Polish labels are stored for the approved genre groups; exposing a language preference in the category endpoint can be added when the app's language setting is defined.
