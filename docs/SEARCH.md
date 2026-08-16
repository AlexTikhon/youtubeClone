# Search and related-video design

## Indexed document

Migration `20260816010000_phase_3_discovery_playlists` adds `Video.searchVector`, maintained by
small Video and Channel triggers:

```text
title                    A
channel name + handle    B
description              C
```

The partial GIN index contains only `READY` + `PUBLIC` rows. The API additionally requires a
publication time, duration, thumbnail, and HLS manifest so results are playable cards. SQL uses
Prisma tagged-template interpolation; user input is never concatenated into SQL.

## Ranking and cursor

`websearch_to_tsquery('english', q)` matches the weighted document. The score is rounded to six
decimal places and combines dominant `ts_rank_cd * 1000` with capped log-view popularity and a tiny
30-day recency signal. Ordering and the keyset cursor are:

```text
rank DESC, publishedAt DESC, id DESC
```

All cursor fields are runtime validated. Query whitespace is normalized, length is capped at 160,
result limits are capped at 50, and the public route is rate limited. The first page captures an
`asOf` timestamp and all later pages reuse it in the recency formula. Without that frozen timestamp,
scores would drift between requests and could repeat a row around the cursor boundary. View-count
changes can still reorder results; immutable search snapshots are intentionally out of scope.

On the tiny seed dataset PostgreSQL correctly prefers a sequential scan (about 0.13 ms locally).
With sequential scans disabled, `EXPLAIN` selected `Video_public_searchVector_idx` through a bitmap
index scan. At production-like row counts normal cost estimates determine when the GIN index wins.

## Related videos

Related results remain deliberately interpretable: same channel gets the largest boost, matching
title/search lexemes add relevance, and small popularity/recency signals break ties. SQL excludes
the current video and every non-PUBLIC/non-READY/unplayable row, and returns at most 20 records. No
candidate set is loaded into application memory and there is no personalization or ML model.

## Count-query trade-off

Search joins `VideoView` and aggregates `COUNT` per candidate. This is reasonable for the bounded
home-project dataset and keeps counts transactionally honest. At materially larger cardinality, an
asynchronously maintained counter or analytics projection could remove that aggregation from the
search path, but it would introduce lag and reconciliation work that is not justified here.
