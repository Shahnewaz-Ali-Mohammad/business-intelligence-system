# Chat, report and graph QA - 2026-10-07

## Scope and method

Tested the running localhost application through its APIs and its actual browser
interface. Temporary accounts and a synthetic warehouse provide known answers;
real customer records were not submitted to the AI during this QA.
This is broad regression coverage, not a proof that every natural-language
question, schema or dataset size will work.

## Findings fixed

| Finding | Fix and regression check |
| --- | --- |
| Explicit OR could execute as AND and falsely return no records | Reject flattened OR and duplicated outer predicates; request bounded planner repair. The disjoint numeric OR case returns four known records. |
| Numeric aggregate thresholds were rejected | Treat measures as numeric filter operands while retaining their aggregation metadata. A count >= 1001 returns only Open: 1001. |
| Group-frequency percentages were confused with shares of tickets | Use database-calculated additive metric shares, not percentages of result groups. Fiber Issue: 1334 / 2001; Packet Loss: 667 / 2001. |
| Equal average/median was described as proof of symmetry | Strengthen writer instructions and remove unsupported distribution-shape claims. Reject invented currencies. |
| Exact-ID replies described averages of a single row | Format actual approved field values directly for at most five matching records. Preserve leading-zero IDs and missing fields. |
| Three example dates were mistaken for all tied dates | Include database-calculated tiedGroupCount alongside bounded high/low examples. |
| A successful warehouse query could hide its report in chat | Executable warehouse replies use the report intent; clarifications remain plain replies. |
| Changing a category in conversation could retain a previous ID | Validate against actual lookup rows. Repair an exact, unambiguous category using verified IDs, without overwriting explicit machine-ID constraints. |
| Graph changes on HAVING reports could change the population | Preserve original grouping, measures and thresholds; restrict incompatible regrouping/style changes. |
| Returning from a saved report lost chat graph/Saved state | Persist the saved report ID and graph settings in the original assistant message; enforce ownership and original-session checks. |
| QA could exceed the graph API rate limit | Pace the test with bounded retries. Production rate limits remain unchanged. |

## Prompt matrix

The 22-case complete matrix passed. Each executable answer is checked for its
known result count and a meaningful title, saved, reopened, and compared with the
report page. Selected cases additionally verify exact columns, aggregate values
and graph totals. The missing-SLA case must clarify instead of inventing a metric.

| Question class | Known result |
| --- | --- |
| Full approved ticket table | 2001 records; Password excluded |
| Fiber category | 1334 |
| Literal leading-zero ID 0001 | One exact record |
| Missing literal ID | Zero; no guessed replacement |
| Fiber with Amount >= 1000 | 668 |
| January 2024 date range | Zero |
| Top five by Amount | Five; insight declares full-population statistics |
| Amount < 3 OR Amount > 1999 | Four |
| One-, two-, five-column lists | Only the requested columns; 2001 records |
| Total ticket count | 2001, not one source record |
| Sum/average Amount | 2003001 / 1001 |
| Count by status | Open 1001; Resolved 1000 |
| Count through approved type join | Fiber 1334; Packet Loss 667 |
| Count by status >= 1001 | Open 1001 only |
| Daily January 2025 grouping | 30 groups; total 2001 |
| Inclusive Amount 10 through 20 | 11 |
| Null LinkId | Zero |
| Exclude Fiber Issue | 667 |
| Exact LinkId L-42 | One exact record |
| Official SLA without a definition | Clarification; no fabricated report |

Additional multi-turn checks change Fiber Issue to Packet Loss (667), then remove
the ticket-type filter (2001), retaining exactly TicketId, Status and Amount.

## Graph and report checks

- Bar, line, KPI, histogram, scatter and density render through the API.
- Returned columns are available with source-table labels; unrelated and invented
  fields are rejected. Graph search is absent.
- Pages of 20, 50 and 100 groups expose all 2001 distinct groups without overlap.
- Histograms and numeric-coordinate aggregation preserve original report filters.
- Empty populations, a constant value, and a small exact scatter are covered.
- A 62001-coordinate fixture preserves all population weights in at most 400 bins;
  it does not silently sample away records.
- Chat preview remains 200 rows; report pages remain 100 rows; Excel includes all
  2001 records plus its header.
- Saved titles, narratives, graph styles and filtered state reopen correctly.
- Ownership isolation, stale-model rejection, restricted fields, conversation
  warehouse binding, and failed activation preserving the active model are tested.
- Browser checks cover generating a graph, saving/reopening a report, continuing
  chat, restoring its graph after reload, table pagination and numeric histogram
  population coverage.
- Live follow-up browser verification returns 667 Packet Loss records with the
  three requested columns; TicketId graph page two shows groups 51-100 of 667,
  and switching to Amount shows a histogram covering 667 of 667 numeric records.
- Desktop and 390-pixel mobile report layouts render a nonblank histogram with
  visible column/style controls and no document-level horizontal overflow.
- Local-only queries also match direct counts in the real ticketing warehouse:
  173061 tickets, 41500 fiber tickets and four non-empty LinkId records. These
  real-data checks do not call the AI or alter the user's connection.

## Verification

- Unit suite: 67 passed; the database-specific test is intentionally skipped in
  the offline suite and passed separately against PostgreSQL.
- Exact summary database suite: 4 passed, including weighted medians and tie counts.
- Complete prompt/report/graph integration: passed, including the scale fixture.
- Separate follow-up and chat-restoration integration: passed.
- Local-only real warehouse count verification: three checks passed.
- Production build and TypeScript validation: passed.

From `apps/bi-dashboard`, the repeatable full integration command is:

```sh
TEST_EXHAUSTIVE=1 TEST_GRAPHS=1 TEST_INSIGHTS=1 TEST_GRAPH_SCALE=1 TEST_FOLLOWUPS=1 node --env-file=.env.local scripts/check-warehouse-onboarding.mjs
```

The script cleans its temporary accounts/schema. Prompt responses and timings can
be written to a selected local JSON file using TEST_AUDIT_PATH. The tested full
matrix audit is `/private/tmp/bi-flow-audit-complete.json`.

## Remaining limits

- Billions of physical records were not tested. Database indexes, capacity, query plans and
  timeouts still determine performance. Exact medians can be expensive.
- Arbitrary AI wording is not fully fact-checked sentence by sentence. Supported
  statistics are supplied and targeted guards exist; model output can still need
  review. Ambiguous or unsupported requests should clarify, not guess.
- Only approved fields and relationships are queryable. Stable full-record lists
  require an established key. Cross-grain metrics are not freely joined.
- Summary payloads are bounded to eight numeric fields, three categories and two
  dates; omitted statistics are declared.
- Top-N graph sources remain explicitly unsupported rather than silently
  replacing a ranked population with the whole dataset.
- Saved reports retain their narrative and query, not an immutable full-data
  snapshot. Reopened tables/graphs can reflect changed warehouse data.
- Old saved narratives are not automatically rewritten by these fixes.

## Expanded stress and combinatorial pass

The follow-up pass extends the 22 prompt classes to 46 with strict/inclusive
comparisons, equality/exclusion, contradictory filters, nested AND/OR, two lookup
joins, positive null checks, string prefixes/suffixes/contains, literal apostrophes,
single-day/month grouping, multi-category grouping, empty HAVING populations,
zero/negative values, restricted fields and unknown fields.

Final expanded run: **46/46 passed**, including applicable report save/reopen
checks and both follow-up corrections. The separately repeated 288-combination
integration also passes with fresh-query behavior enabled. Final prompt audit:
`/private/tmp/bi-flow-audit-expanded-final.json`; filter-run audit:
`/private/tmp/bi-flow-audit-filter-final.json`.
Prompt-case wall times (including report/graph verification, not just AI latency)
have a 6130.5 ms median and 13331 ms maximum in that run.
The million-row graph/summary/chat checks passed in the preceding scale run;
that iteration still contained the record-list insight failure subsequently
fixed and verified by the final 46-case rerun. Its audit is
`/private/tmp/bi-flow-audit-expanded-verified.json`.

Additional defects found and repaired:

- An explicit `LinkId is not null` could become `IS NULL`. Schema-grounded null
  handling now preserves the explicit predicate; combined opposing null checks
  are not collapsed into one condition.
- A keyed `List Tickets ...` request could gain a redundant record-count measure,
  producing count-by-record analysis instead of record details. Remove that
  redundant measure only for unambiguous keyed lists, never aggregate/HAVING
  requests or other measures.
- Cube could return the old 2001-row cached population immediately after the
  source grew to one million rows. Live warehouse and ISP loads now explicitly
  request fresh execution. This costs a source query rather than serving stale
  data; it is not a transactionally consistent snapshot across separate requests.
  The behavior is covered by a transport regression and the real source-growth
  integration test. See [Cube's cache-mode contract](https://github.com/cube-js/cube/blob/master/packages/cubejs-client-core/src/types.ts).
- A graph offset had an arbitrary one-billion cap. Graph bounds now permit safe
  integer offsets while rejecting overflow. This is a validation test, not a
  successful physical five-billion-offset database benchmark.
- Failure-fallback summaries could display internal generated member names.
  Category/date metadata now carries readable column titles.

Confirmed additional coverage:

- 288 executed Cube filter/join combinations match independent PostgreSQL counts:
  252 numeric operator/threshold/lookup combinations plus 36 nested boolean cases.
- All 511 non-empty subsets of a nine-column catalog and their 2031 supported
  style combinations pass scoped-column/style validation. These are contract
  tests; not 2031 individual browser renderings.
- One million physical records, using 165027840 bytes including indexes, pass
  bar, line, KPI, histogram, scatter and density population checks. Numeric
  distributions return at most 400 bins while accounting for all matching rows.
- The million-row final graph page, exact average/median (500000.5), sum
  (500000500000), fresh AI insight, capped 200-row preview, saved narrative and
  final 100-row report page pass. The fixture is then removed, and the restored
  2001-row Excel export passes. A million-row Excel export was not tested.
- Measured million-row graph request times: bar 322 ms, KPI 822 ms, histogram
  3133 ms, scatter 4192 ms, density 4258 ms. Line's 61836 ms included a deliberate
  61-second API-rate-limit wait and is not an isolated query latency measurement.
- Weighted PostgreSQL fixtures representing five billion observations preserve
  exact counts, sums, average/median and graph-bin weights. The summary fixture
  uses 50 values weighted by 100 million; distributions use 500 coordinates
  weighted by 10 million. This validates arithmetic, NOT five billion physical
  rows, storage, scans, joins, deep pagination or concurrent-user performance.
- Numeric-distribution checks also cover null coordinates, negatives, zeros and
  an all-null population without inventing coverage.
- Current offline suite: 72 passed and one database test skipped; the separate
  PostgreSQL summary suite passes all four tests. Production build passes.

Repeat the expanded integration from `apps/bi-dashboard`:

```sh
TEST_EXHAUSTIVE=1 TEST_EXTENDED=1 TEST_GRAPHS=1 TEST_INSIGHTS=1 TEST_GRAPH_SCALE=1 TEST_SCALE_ROWS=1000000 TEST_SCALE_CHAT=1 TEST_FOLLOWUPS=1 node --env-file=.env.local scripts/check-warehouse-onboarding.mjs
```

For the finite filter/join cross-product, add `TEST_FILTER_MATRIX=1`.
For a focused graph/scale pass, add `TEST_GRAPHS_ONLY=1`.
All temporary database fixtures/accounts are cleaned on exit.

## Existing ISP Chat: LinkId Regression

The preceding new-warehouse tests did not prove the existing ISP conversation
path. Session 46 has no warehouse binding and uses the static ISP Cube catalog.
That catalog previously omitted LinkId and other raw ticket details. The
existing IspTicket model now exposes 50 dimensions, covering all 46 source
columns plus the warehouse-specific fields. Its left join uses the unique raw
SNID against source_ticket_id; a live check confirms that it does not multiply
the current 173062 warehouse ticket rows.

Additional fixes cover catalog-derived spelling aliases, explicit null versus
empty-string predicates, populated-ID exclusions, ID alternatives incorrectly
planned as date ranges, and column-list conjunctions mistaken for literal IDs.
Unambiguous simple requests use a bounded schema-derived plan; complex requests
still pass through the AI planner and shared field/filter/join validation.
Unknown fields are not substituted. These guards are not a claim that every
possible natural-language question has been tested.

The authenticated regression runner compares 16 real ISP prompts with independent
PostgreSQL counts/groupings, saves and reopens all generated reports, verifies
their titles/narratives/queries and table pagination, and checks LinkId graph
population totals, returned-column options, and persisted graph settings.
It uses a temporary QA account rather than modifying session 46 or source tickets.

Current database facts: 16 tickets have a non-null LinkId; 12 of those contain an
empty string, leaving 4 populated values. 614110 has 2 tickets; 34097 and 614109
have 1 each. SQL NULL, an empty string, and a missing literal ID remain distinct.
These are observed database values, not hardcoded response mappings.

The offline suite passes 76 checks with one PostgreSQL-only check skipped; the
separate PostgreSQL summary suite passes all 4 checks. Contract coverage includes
359 catalog-derived exact/null request plans and the existing 511 column subsets
and 2031 supported graph-style combinations. TypeScript checking passes.

Repeat the actual legacy ISP flow from apps/bi-dashboard:

```sh
node --env-file=.env.local scripts/check-isp-ticket-chat.mjs
```

The detailed audit is written to /private/tmp/bi-isp-ticket-chat-audit.json.
The final run passes all 16 scenarios. Browser verification in the in-app
browser also submits the previously failing LinkId grouping question, checks
the fresh statistical insight and five-row result, generates a graph, saves
the report, and reopens it with the same insight and graph settings. Screenshot:
/private/tmp/bi-isp-reply-verified.jpg. The temporary browser QA account and its
reports are removed after verification; no user-owned reports are removed.
Reports retain executable queries for complete live pagination, not a frozen
snapshot of every source row. Existing incorrect historical messages are not
rewritten; ask the question again to execute the corrected pipeline.
