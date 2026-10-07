# Query and graph coverage

Graph functionality is currently removed from chat and report pages at the
user's request. The chart-query endpoint and graph-settings PATCH handler
are removed. New report saves do not generate chart specifications. Tables,
insights, pagination, exports, and existing stored report data are retained.
The graph implementation notes below describe the prior implementation,
not an enabled feature.

The ISP Cube catalog is read from `cube/model/isp.yml`. Changes to the model
are reflected in the chatbot's field enums and graph selectors after the
backend reloads. All columns in the 14 current business warehouse tables are
modeled. `IspFinancial` combines financial streams with UNION ALL before
aggregation, so billing and collection transactions are not multiplied by
a raw fact-to-fact join. Its totals were reconciled with the existing services.

Queries support exact record IDs, selected columns, measures, grouping,
numeric comparisons, null checks, dates, and AND/OR filter groups. Validated
query plans take precedence over incompatible named-tool choices and
contradictory no-data classifier flags. Leading zeros and large IDs are
preserved. The AI receives compact results; report tables receive their
own paged data. Custom queries reuse their first result page.

Reports with a stored query use three shared graph panels: bar, line, and
heatmap. Graphs aggregate in Cube rather than plotting the loaded table
preview. Categories and time buckets have independent windows; no categories
are folded into an Others bucket. Search, selected metrics/dimensions,
sorting, linked selections, intervals, styles, and window positions are
stored in `chart_spec.exploration`. Graph-only saves do not replace report
data. Existing table preview and pagination sizes are unchanged.

Reports remain live query-backed views, not immutable copies of every
matching database row. Old reports without a query retain their existing
stored-data charts; regenerating them adds database-backed exploration.
Graph views explore matching source records, independently of a table's
loaded preview. A ranked table's top-N is not a historical data snapshot.

Known data limits remain explicit: resolved ticket dates are unconfirmed,
and no customer-to-region relationship is defined. A missing source value
or relationship is not invented. Arbitrarily phrased questions and every
possible cross-fact combination cannot be guaranteed by a finite test suite.
Large datasets keep browser payloads bounded; cold database aggregation
time still depends on indexes, Cube caching, and the selected filters.

Report planning distinguishes analytical POP/package reports from reference
directories and full customer/ticket records. Analytical directory upgrades
are validated so a previous names-only query cannot silently replace a
performance breakdown. Specific titles are planned with each request.
Custom-query insights use separate full-filtered aggregates and a database-
ranked leading category, never a sum of the displayed page. Aggregate
thresholds preserve grouping when finding the leading matching group.
Summary failures are disclosed rather than replaced with fabricated values.
Planning now receives a cached dictionary of actual reference labels and
stored categorical codes. Names are resolved to real IDs, duplicate labels
retain every matching ID, and ambiguous/missing code mappings trigger a
clarification instead of a guessed empty result. Ticket category terms are
not customer connection-technology codes. Query verification checks literal
IDs, missing explicit category filters, invalid date operators, and safe
many-to-one joins; a failed plan gets one repair attempt before a limitation
is returned. The fallback agent receives the same reference dictionary.
Primary-key record lists count their full filtered population separately
from the bounded page, avoiding expensive grouping over every wide record.
Missing counts are errors, not fabricated zero counts.
Full-detail record requests include all modeled record columns; explicit
column subsets remain honored. Package refunds and adjustments are included
in newly generated package report data and tables. POP reports include names;
unfiltered POP/package reports also retain reference entries with no activity.
Existing saved report
titles and narratives are not retroactively rewritten; regenerate those
reports to apply the new planning and summaries.

Verification commands (from the dashboard directory, using its environment):

```sh
node --test ../bi-warehouse/src/semantic/semantic.test.mjs
node --test ../bi-warehouse/src/semantic/valueGrounding.test.mjs
node --env-file=.env.local ../bi-warehouse/scripts/audit-semantic.mjs --counts
node --env-file=.env.local ../bi-warehouse/scripts/check-chart-queries.mjs
node --env-file=.env.local scripts/check-bi-agent.mjs
node --test scripts/lib/query-insight.test.mjs
npx tsc --noEmit
```

The live checks used approximately 6.3 million billing records and 173,000
tickets. A 500-million-row count was tested with a transport fixture, not
with a physical 500-million-row warehouse. Desktop/mobile graph rendering
and configuration changes were tested with a temporary fixture, removed
after verification. Authenticated report saving must also be exercised in
a signed-in browser; the verification browser did not have a session.

The October 5 query regressions include category names/typos, corrected
follow-ups, exact and nonexistent IDs, ACTIVE customer status, date windows,
OR category alternatives, exclusions, null dates, numeric amount ranges,
joined grouping, complete record columns, and analytical report titles and
summaries. Expected counts are checked independently in PostgreSQL. Actual
Fiber Issue tickets total 41,500, including 9,956 opened in January 2025.
An unknown English label for a numeric connection code is not treated as
proof that there are no tickets. All 14 modeled table counts were reconciled;
empty department, lifecycle-event, and date tables are genuinely empty.

For deployed builds, include the model file or set `CUBE_MODEL_PATH` to its
absolute location. The dashboard's tracing configuration includes the model.
