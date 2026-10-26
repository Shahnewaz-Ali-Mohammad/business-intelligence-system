# Procedure Report Verification - October 18, 2026

## Verified Real Flow

- Workspace: Test BILLING.
- Already-approved procedure: dbo.app_MonthlyCollectionSummaryGraph.
- Fresh background run: 271411bf-0ab3-44e2-9bea-883b9f9bc740; chat session 170.
- Completed successfully with three result rows and return code 0.
- Grounded insight completed; Amount total verified as 35,712.
- Graph generated from all three stored rows; grouping and metric changes worked.
- Customer column hidden; Label and Amount retained.
- Saved report 421 reopened with final insight, column visibility, and graph settings preserved.
- Excel export 42 and PDF export 43 created through the interface.
- Authenticated download endpoints returned HTTP 200 and correct file types.
- Downloaded Excel parsed: three data rows, correct values, hidden column excluded.
- Downloaded PDF parsed and visually rendered: one clean page, correct values, hidden column excluded.

## Automated Verification

- Production build and TypeScript passed.
- Full selected automated suite: 216 passed, zero failed.
- Focused coverage includes worker lifecycle, stale approval checks, parameter binding/defaults, cached result paging, graph scope, and estimated median labels.

## Limits

- A second parameterized procedure, dbo.app_dashboardSummary, required approval under its current metadata. It was not approved or executed during this check.
- This verifies one fresh real procedure end to end, not every SQL Server procedure or arbitrary data volume.
- PDF includes insight, result tables, and output parameters, not the web chart.
- Unicode PDF font coverage and scheduled execution were not freshly verified end to end.
- No source database schemas, tables, or business records were created or changed. Normal application chat, report, and export records were saved.
