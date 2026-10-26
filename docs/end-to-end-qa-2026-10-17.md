# BI Flow Verification: 2026-10-17

## Verified

- 195 automated tests pass across schema coverage, query validation, MCP calls,
  joins, calculations, report identity, generation recovery, graph plans,
  insight grounding and AG-UI streaming. These do not prove every question.
- Production build and TypeScript pass after repairing the workspace chat route.
- Signed-out setup and MCP requests return 403 without exposing connections or
  tools. Cross-origin setup mutation is rejected.
- The app database contains all ten checked workspace, connection, tool,
  version, test, conversation, report and export storage tables.
- Real SQL Server discovery and bounded record/ID queries pass:
  - TicketingDB: 1,110 objects, 12 views, 889 procedures.
  - billGENIXDB: 1,606 objects, 19 views, 1,307 procedures.
- 131 generated templates for Tk_TicketInfoMaster and 130 for BillingMaster
  pass zero-row SQL Server preflights. This is selected-table verification,
  not execution coverage of every table or procedure.
- Filtered population statistics agree with graph grouped counts on actual
  existing records in both databases.
- Live OpenAI generation using the configured gpt-6-astra model and actual
  DepartmentMaster schema succeeds. Two independent runs produced 39 and 38
  validated proposals, respectively; template preflights passed. This is not
  a fixed expected tool count. No generated proposal was saved or approved.
- Live insight generation from database-computed department count statistics
  succeeds and emits checked incremental text, rather than a fallback. This
  exercises the backend streaming callback, not browser rendering.
- Signed-in browser checks pass on the production build:
  - Existing saved MIS connection discovers its real objects successfully.
  - The visual schema-tool test groups OfficeCat by IsActive and returns 10.
  - Setup opens the selected database; a two-database workspace has a selector.
  - A grouped office question returns 10 groups matching an independent SQL
    baseline: total 767, highest 407, lowest 2, average 76.7, median 6.
  - Category labels are resolved through the approved relationship and rendered
    in the graph. Graph field selections survive saving and reopening.
  - Chat history survives reload and Continue in workspace chat restores it.
  - The exact unlimited-detail follow-up returns only COMPID and Name, not a
    grouped count. Saved pagination reaches page 3, rows 201-300 of 767.
  - Record graph generation uses all matching records, not the current page.
    The 100-group display bound and omitted groups are explicitly disclosed.
  - Excel download contains all 10 grouped rows and sums to the SQL baseline
    of 767. The stored export snapshot has the same SHA-256 as the download.
    Its history entry appears in the correct workspace.
  - Switching to the empty QA workspace shows neither MIS chats, reports nor
    exports; switching back restores MIS content.
  - Saved report inspected at desktop and 390px mobile widths; mobile document
    width remains 390px, with graph/table scrolling inside the report.

## Fixed

- A missing catch clause prevented the workspace chat API route from compiling.
  Restored failure tracking and safe propagation. Added a regression check that
  parses every API route, including routes not imported by existing unit tests.
- On a summary failure, the tool evidence incorrectly described zero matching
  records. It now distinguishes unavailable statistics from zero records and
  explicitly prevents interpreting a bounded preview as full-population facts.
  The final displayed answer also discloses unavailable summary statistics.
- Database selection was dropped by setup-to-chat navigation; added explicit
  source binding, a multi-database selector and an empty-workspace setup link.
  Initial workspace naming is resolved before mounting the chat greeting.
- Workspace aggregate results unnecessarily went through a second narrative
  critique/retry before the dedicated insight writer. A live grouped question
  timed out despite correct SQL. Intermediate workspace narrative is now
  discarded when verified report evidence exists; final insight grounding is
  retained. Original-workspace critique behavior is unchanged.
- Numeric grouping codes were averaged as business measures. Aggregate summary
  statistics now describe metric outputs only. Group missing/empty coverage is
  separately computed over the uncapped population before completeness claims.
- Legitimate loopback requests failed the origin check because NextURL changes
  127.0.0.1 to localhost. Validation uses the actual destination Host and exact
  scheme/port. Foreign origins remain rejected; added regression tests.
- Successful results could inherit a model's missing-capability title. Such
  status titles are no longer used for a successfully executed report.
- Saved graph visibility persisted but selected metric/category did not. Both
  field selections now persist with the report snapshot.
- Full Excel exports were stored without report linkage or file contents.
  Exports now require an owned report matching workspace, source, tool and
  exact query; the linked file content is retained for re-download.
- "Do not limit the total report" incorrectly selected aggregate tools for a
  detail follow-up. Shared intent handling excludes this limit directive,
  selection restricts report mode, and execution rejects wrong-mode plans.

## Remaining Coverage Limits

The fresh-connection form was inspected but no extra credentials or duplicate
connection were saved. Real connection validation was checked through the
source connector and an existing saved connection's discovery action.
Live AI proposal generation and preflights ran without persisting new tools.
Generation-job resume/cancel and draft approval/revocation are covered by
automated tests, not a new owner-account UI generation/approval cycle.
ID-list, NULL and date-range combinations have compiler/MCP coverage, not a
separate browser prompt for every combination. No universal question coverage
or billion-row performance is claimed. Existing
full XLSX exports accumulate rows in memory; they are not evidence of unbounded
export scalability.
The original workspace dashboard backend returned a database-read error during
initial browser setup; the original warehouse/Cube service stack was not
reconfigured or claimed healthy by these direct-database workspace checks.

## Data Safety And Reproduction

No source inserts, updates, deletes, schema changes or procedure execution.
No synthetic source tables or rows. Application storage contains the normal
chat messages, saved reports (412, 413, 414), export history/file and tool-test
record produced through UI testing. Existing saved catalog metadata was
refreshed by discovery. No tools or connections were replaced, approved or
deleted. Earlier failed/incorrect test answers remain in the test conversation
for audit; only subsequent answers exercise the corresponding fixes.
Live AI generation sent schema metadata; the insight check sent computed counts,
not customer records. Existing API credentials were used without printing them.

From apps/bi-dashboard:

```sh
node --test lib/tool-setup/*.test.mjs scripts/lib/*.test.mjs scripts/chat/*.test.mjs
npm run build
node scripts/check-tool-setup-access.mjs
node --env-file=../bi-warehouse/.env scripts/check-tool-setup-source.mjs
# Optional: uses API credits; no registry/source writes.
node --env-file=.env.local --env-file=../bi-warehouse/.env scripts/check-tool-setup-source.mjs --ai
```
