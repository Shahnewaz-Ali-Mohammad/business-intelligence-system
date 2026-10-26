# Scheduled Procedure Report Verification

Date: October 18, 2026. All displayed times below use Asia/Dhaka.

## Real Timed Test

- Original saved report: 421, dbo.app_MonthlyCollectionSummaryGraph, Test BILLING workspace.
- Selected 16:14 in the report's Schedule form at approximately 16:11; independently verified the persisted nextRunAt as 1792318440000.
- Did not manually trigger the due report. The dedicated n8n Schedule Trigger called the BI endpoint automatically every minute.
- n8n execution 12 started at 16:14:11.177 and succeeded. Its response showed one due report, original report 421, new report 422, status running.
- Background run 16881fa3-0184-4e89-9c08-bc696de4afd9 started at 16:14:12.937 and completed at 16:14:19.445, return code 0.
- Live report schedule status refreshed from running to completed without a page reload.
- Exactly one generated_reports row linked back through scheduledFrom=421, even after subsequent minute checks.
- New report 422 contained a fresh AI narrative and all three source result rows. The graph and hidden Customer column were retained.
- Paused the test schedule through the interface after completion. Its saved enabled flag is false and nextRunAt is null; it will not repeat tomorrow.
- Two concurrent trigger checks after pausing returned due=0 and no outcomes. A trigger request without a key returned 401.

## Saved Output

- Application database: generated_reports row 421 stores data.schedule, including lastRunAt, lastStatus, lastReportId and lastError.
- Generated report: row 422 stores scheduledFrom=421 and its workspaceToolAnswer with the new procedure run ID.
- Procedure run and cached full results: apps/bi-dashboard/.data/procedure-runs/7bb6f9ca-72b3-472d-a41a-345ea8ef2d1a/16881fa3-0184-4e89-9c08-bc696de4afd9/.
- Owner notification: apps/bi-dashboard/.data/notifications/.
- n8n workflow and execution history: dedicated bi-reports_n8n_data Docker volume; workflow BiScheduledReports01.
- Scheduled report Excel export 44 and PDF export 45 both downloaded through authenticated history endpoints with HTTP 200 and correct MIME types.
- Parsed Excel headers were Label and Amount, with rows May-26/11774, Jun-26/12545, Jul-26/11393; sum 35712. Hidden Customer was excluded.
- Parsed PDF contained all three expected labels and values on one page.
- Visually checked the rendered PDF. Verified the new report in the workspace's Reports list, opened its completion notification, and retested both latest-run and same-report notification links with correct workspace navigation.

## Fixes Found During Testing

- Existing running n8n belonged to a different project and contained no BI report workflow. Started a separate BI instance on localhost:5679, leaving that project untouched.
- Pinned n8n to the installed official version 2.42.4, supplied the required stable workflow ID, imported and published the workflow, and enabled successful execution history.
- Changed checks from every five minutes to every minute. This remains polling, not an exact-to-the-second trigger.
- Corrected report time submission: the browser displayed the edited time but originally saved the old value. The form now submits its actual time field.
- Added live schedule status refresh without overwriting a form being edited.
- Strengthened schedule claiming to require the full saved schedule to remain unchanged and enabled, protecting against concurrent pause/edit races.
- Corrected report-detail navigation to restore workspace/source context when opened from a latest-run or notification link without query parameters.

## Verification And Limits

- Production build and TypeScript passed; full selected suite: 216 tests passed. Focused schedule, procedure-flow and lint checks passed.
- This is one verified real read-only procedure, not proof of every procedure, failure mode, or data volume.
- Post-pause concurrent checks were tested; deliberately racing two claims at the exact due instant was not performed.
- n8n must be running and able to reach the BI app. During this test its BI_APP_URL targets the updated server on port 3001.
- The temporary test schedule is paused; the scheduler service remains available for future schedules.
- No source business records, tables, schemas, or procedure definitions were created or changed. Only normal application schedule/report/export records and the dedicated scheduler configuration were written.
