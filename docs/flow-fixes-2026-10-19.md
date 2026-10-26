# Flow Fix Verification - October 19, 2026

## Changes

- Updated the dedicated BI n8n instance's BI_APP_URL from port 3001 to port 3000, matching the running application. Recreated only bi-reports-n8n-1; other projects' workflows were untouched. Subsequent automatic executions succeeded.
- Rolling-date BETWEEN and equality filters now use start-inclusive/end-exclusive bounds. Regression cases include the last day's late-night timestamps and exclusion of the next day's midnight, while preserving unrelated filters.
- Rolling procedure date values are now paired with an updated omitted-parameter list. Only explicitly overridden date parameters stop using procedure defaults; unrelated defaults remain unchanged. Time-only and output parameters are not treated as date-range inputs.
- Report requests have a 20-second deadline, explicit authentication/server/malformed-response errors, and a Retry action. Navigation cancels outstanding requests, and changing reports resets component state.
- Separated development output (.next-development) from production builds (.next) to prevent verification builds sharing the development server's cache. Existing generated output was not deleted.

## Verification

- Full selected automated suite: 229 passed, zero failed.
- Production build and TypeScript passed. Lint passed for changed modules.
- On localhost:3000, verified the signed-out report screen shows a sign-in error rather than indefinite loading. Signed in with the existing account, then opened saved report 422 successfully.
- Confirmed report 422's workspace, graph and all three visible table rows: May-26/11774, Jun-26/12545 and Jul-26/11393. Captured a screenshot of the rendered graph and table.
- Confirmed n8n's configured target is http://host.docker.internal:3000 and its minute checks return successful executions again.

## Scope

- No source business records, source tables, schemas or stored-procedure definitions were modified. Verification did not run a new source report or change existing schedules. Signing into the app created a normal application session.
- Rolling-date boundary/default behavior was regression-tested without writing synthetic data to any database. A new timed live procedure run with omitted defaults was not performed in this verification.
- Procedure end-date interpretation remains the existing inclusive-date convention; the date-filter fix does not rewrite business logic inside stored procedures.
