# Full-population analytical insights

The generic ISP Cube query and connected-warehouse chat paths now calculate
database statistics before asking the AI to write an insight. Legacy ticket
and customer lists use the same summary writer. The customer financial
summary passes its existing per-customer averages, medians, percentile and
outstanding extremes to the writer instead of using only a fixed template.

`reportSummary.mjs` compiles a validated Cube query and wraps its SQL in a
read-only summary query. Filters, date scope, joins, grouping and aggregate
thresholds remain intact. Only the outer preview/ranking limit is removed;
the AI receives the ranking limit separately and is told the statistics
describe the pre-ranking population. Record counts preserve duplicate-row
weights when unused detail fields are omitted from the summary projection.

Statistics include non-null/missing counts, minimum, maximum, weighted mean,
exact weighted median, population standard deviation, zero/negative counts,
and additive sums. Grouped measures also include bounded high/low examples
with their category/date labels and shares of additive metric totals. Category summaries for record lists include distinct groups,
missing values, leading/trailing categories and database-calculated shares.
Date fields include their earliest/latest values. IDs are not numeric metrics.
Non-additive rates are not summed; grouped statistics are identified as
group-level statistics, not individual-record statistics.

The payload is bounded to eight numeric fields, three categorical fields,
and two dates; omitted fields are declared. General reports contain no raw record preview.
Specific lookups returning at most five records also provide those approved fields
to a direct factual formatter, so the answer describes the requested record instead of statistics
about a single-row dataset. Scalar aggregates use direct factual wording without
an additional AI writing call. Group-frequency percentages are not presented as
metric shares in grouped reports.
Bounded high/low examples include exact tie counts, so three example dates cannot
be mistaken for all dates sharing an extreme value.
Only approved many-to-one reference names may supplement raw record lists.
Existing table preview, pagination, export and report-save behavior is unchanged.

The AI receives the question and verified summary in one bounded writing call
(20-second timeout, no automatic retry). It is instructed to compare meaningful
statistics without inventing causality, trends, definitions or figures. If AI
wording fails, factual statistics remain visible. Database-summary failures are
explicitly disclosed. Exact statistics use a 20-second database timeout; large
populations can require indexes, caching or query tuning. No unlimited-scale
latency guarantee or exhaustive natural-language coverage is implied.

New replies and newly saved narratives use this behavior. Existing saved
narratives are not rewritten automatically.

Verification from `apps/bi-dashboard`:

```sh
node --test scripts/lib/analytical-insight.test.mjs scripts/lib/query-insight.test.mjs ../bi-warehouse/src/semantic/reportSummary.test.mjs
TEST_SUMMARY_DB=1 node --env-file=.env.local --test ../bi-warehouse/src/semantic/reportSummary.test.mjs
TEST_GRAPHS_ONLY=1 TEST_INSIGHTS=1 node --env-file=.env.local scripts/check-warehouse-onboarding.mjs
```

The database integration uses synthetic fixtures and cleans up its temporary
account and schema. It verifies full-population statistics, filter preservation,
AI analytical wording, unchanged pagination and full exports.
