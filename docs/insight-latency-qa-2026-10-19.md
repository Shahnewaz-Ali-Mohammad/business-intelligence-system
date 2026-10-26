# Workspace insight latency verification

Affected conversation: Test BILLING, session 170.

## Findings

- A successful query calculated the full summary during the MCP call and again during final rendering.
- Detail summaries also launched four optional median sorts over millions of records.
- Agent retries could execute the identical successful query again.
- Completion auto-scroll moved below the insight to the table.

## Changes

- Execute a bounded detail page and publish its preview before statistics finish.
- Reuse the execution and summary for final rendering, after rechecking approval.
- Request-local memoization shares identical concurrent/repeated executions; failed executions may retry. No cross-user or cross-request caching.
- Large detail reports retain full-population count, present/missing, minimum, maximum, average and sum. Optional medians above 100,000 records are explicitly unavailable, not sampled or fabricated. Explicit analytics calculations are unchanged.
- Allow the single full-detail aggregate up to 60 seconds, instead of failing at 30 seconds then repeating it. The overall request deadline remains enforced.
- Open a newly completed assistant turn at its insight rather than below its table.

## Verification

Browser: localhost:3000, existing authenticated Test BILLING conversation.
Fresh prompt: Show all BillingMaster records.
Verified completed narrative and table, including 12,483,367 full matching records and a 200-row detail page.

Saved server stage timings:

- Understanding question: 3,573 ms
- Reading database: 14,989 ms
- Preparing report: 125 ms
- Writing insight: 2,226 ms
- Total: 20,913 ms

Earlier affected reply: approximately 86 seconds, including approximately 40 seconds in each of database reading and final preparation.

Reopened the conversation and verified the insight remains visible above report controls. Screenshot: /tmp/bi-insight-fixed-2026-10-19.png.

236 automated tests passed, including request reuse, retry isolation, early-preview ordering, avoiding duplicate final execution, and median policy. TypeScript passed. Focused lint passed with two pre-existing unused-variable warnings in chat-workspace.tsx.

Source business data was not modified. Normal test chat messages were saved by the application. This verifies the affected flow, not every possible database query or stored procedure.
