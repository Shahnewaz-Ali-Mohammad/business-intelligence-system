# Workspace Query Verification

Verified on 2026-10-11.

## Implemented Flow

Connect a server in Data Sources, discover a database, select its tables and
verified relationships, generate tool drafts, test and approve tools, then open
Workspace Chat and select the database. Only approved schema-capability tools
are selectable by this chat. Query plans are validated and values are bound as
parameters; the model does not supply executable SQL.

Answers stream through AG-UI events. Successful answers and clarifications are
saved to workspace conversations. Follow-ups use server-stored conversation
history. Changing databases requires a new conversation. Reports save a page
snapshot plus the validated query for subsequent live pagination. Those live
pages can change as source data changes.

Numeric summaries query the uncapped result population in the database.
Statistics include minimum, maximum, average, total, median and missing values
where meaningful. Identifiers are excluded. A failed summary is disclosed;
preview statistics are never substituted as full-population statistics.

Database workspaces now reuse the original ChatWorkspace component, including
its composer, bubbles, streaming area and scroll behavior. Sidebar database
links select isolated source IDs; saved conversations are checked against that
source before restoring. Workspace report and recent-conversation lists accept
workspace/source filters, while the global lists remain available.

Record-report graphs use the matching approved analytics tool to count the full
matching population by a returned report column. Up to 100 groups are displayed
and additional groups are disclosed. Changing the grouping repeats the
database query rather than aggregating the preview in the browser.

Aggregate graphs use returned metric aliases and returned grouping columns.
They have column selectors and horizontally scrollable categories. Graphs and
CSV exports represent the current result page, not the full dataset.

## Checks

- 57 compiler, coverage, MCP, summary-query, graph-plan and AG-UI tests passed.
- TypeScript and the production build passed.
- Targeted lint and whitespace checks passed before the final navigation patch.
- Real TicketingDB metadata discovery, bounded SELECT and specific-value lookup passed.
- Real billGENIXDB metadata discovery, bounded SELECT and specific-value lookup passed.
- Source checks did not insert, update, delete or create any source objects.
- Browser confirmed the workspace interface renders and rejects unauthenticated access.

## Not Yet Proven Or Supported

Authenticated end-to-end model answers, persisted reports and populated graph
interactions have not been browser-verified in the owner's account. The browser
session available for verification was signed out. Compiler tests do not prove
every natural-language question, every source query or billion-row performance.

The current query language supports conjunctions of its documented predicates,
approved many-to-one joins and count/sum/average/min/max metrics. Arbitrary OR
trees, cross-database joins, date bucketing, forecasts and custom formulas are
not silently substituted. Median is available in full-result summaries, not as
an arbitrary query metric. Pagination is bounded to a maximum offset of one
million. Graphs are not an uncapped full-population visualization. Stored
procedures are not automatically executed because their side effects cannot be
assumed read-only.
