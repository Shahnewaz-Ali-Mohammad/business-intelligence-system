# On-Demand Report Graphs

Chat reports and saved reports share `ReportGraph`. Nothing is generated until
the user clicks **Generate graph**. One small structured AI call recommends one
of bar, line, KPI, histogram, scatter, or density. Its input contains the report
title and a bounded shortlist of approved field names/types, not table rows,
filter values, credentials, SQL, or the report narrative. The complete approved
field list remains available in the graph settings. Invalid or unavailable AI
recommendations fall back to a deterministic schema-based choice.

Graph fields are restricted to the columns selected by the report query, not
all fields reachable through warehouse joins. Filter-only, ordering-only, and
date-range-only members do not become graph choices. Selected measures and one
clearly labeled computed record count are available; unrelated sum/average
metrics are not added. Joined columns are available only when the report
explicitly returns them. Saved configurations with out-of-report fields are
rejected with a regeneration message and the corrected field options.

Style and field changes make database requests without another AI call.
The Column selector is always visible and lists every returned field grouped by
its source table. Selecting a category/identifier uses a frequency graph,
selecting a date uses a trend, and selecting a numeric value uses a distribution.
IDs are never treated as numeric amounts. Numeric comparisons expose a second
column selector. Advanced ordering/time settings are hidden initially.
Search and click-to-focus are removed. Older
saved searches are ignored. Ordering, date interval, page size, and page position
are saved in `chart_spec`. Explicit existing graph filters remain removable.
The original report query and original filters remain unchanged. Save Report
stores the graph in chat; Save graph updates an existing saved report.
Reopening a report restores its settings and queries live data, not a frozen
image or a copy of every database row.

## Large Datasets

- Bar charts aggregate the matching population and page 50 categories by default,
  with 20/50/100-group choices and navigation above the plot. Horizontal bars
  scroll within the chart so every label on the current page is rendered.
  There is no synthetic "Others" category. Paging reaches every remaining group.
  Available status/type categories are preferred over customer-name rankings.
- Line charts aggregate dates with the same page choices; the interval is adjustable.
- KPI charts aggregate the full matching population into one number.
- Histograms use 20 database-computed numeric bins.
- Scatter charts show exact grouped coordinates when there are at most 200.
  Larger coordinate sets switch to a 20-by-20 density view; weighted counts
  preserve all matching usable records rather than sampling the chat preview.
- Density charts always use the bounded density view.

Numeric distributions use trusted Cube-generated SQL. A PostgreSQL AST parser
removes only its outer preview limit/order. Nested model limits, predicates,
parameter values, and verified member aliases remain intact. A fixed read-only
SQL wrapper computes bins and coverage counts in PostgreSQL. Missing numeric
values are disclosed as usable records versus matching population.

The graph response is bounded, even when the source is large. This does not make
an arbitrary multi-billion-row scan instant: warehouse capacity, indexing,
pre-aggregation, and query timeouts still matter. No billion-row benchmark has
been performed. Failures show an error rather than a partial graph labelled
complete.

## Boundaries

Graphs require a saved semantic/database query. Legacy snapshots without one
must be regenerated. Explicit top-N reports currently return an explanatory
message instead of silently expanding their requested cohort. Unsupported
field combinations and stale/unapproved warehouse models are rejected.

Warehouse access is checked against the authenticated owner and model version;
all source and derived queries are validated. The graph endpoint accepts no
AI-written or client-written SQL. Numeric execution uses read-only transactions.
The existing 200-row chat preview and 100-row report pagination are unchanged.

## Verification

Run semantic tests in `apps/bi-warehouse` with `node --test
src/semantic/reportGraph.test.mjs`. In `apps/bi-dashboard`, the disposable
warehouse integration suite supports `TEST_GRAPHS=1 TEST_GRAPHS_ONLY=1` and
`TEST_GRAPH_SCALE=1`; the latter verifies 62,001 distinct numeric coordinates
survive Cube's SQL cap while the browser response stays at most 400 bins.
`TEST_GRAPH_UI=1` holds synthetic fixtures for browser testing until stdin
receives input. It uses a test-only password and removes its accounts/schema
in `finally`; never enable it against non-disposable accounts.
