# Scheduled reports with n8n

The BI app keeps the schedules: open a saved workspace report → **Schedule** → choose daily, weekly or monthly and a time.
n8n only triggers the check: every minute it calls the BI app, which runs every report that is due, saves the result as a new report and shows a notification (bell, top-left). A report normally starts within a minute of its selected time, provided both services are running.

## One-time setup

1. Create a key: `openssl rand -hex 32`
2. Add it to `apps/bi-dashboard/.env.local`:
   `AUTOMATION_API_KEY=<key>`, then restart the BI app.
3. `cp n8n/.env.example n8n/.env` and set `BI_AUTOMATION_KEY=<same key>`.
4. Start n8n: `cd n8n && docker compose -p bi-reports up -d`
5. Open http://localhost:5679, create the n8n owner account. This port and Compose project are separate from other applications' n8n instances.
6. **Workflows → Import from file →** `n8n/workflows/run-scheduled-reports.json`, then switch the workflow **Active**.

Alternatively, import and publish using the installed CLI:

```sh
docker cp workflows/run-scheduled-reports.json bi-reports-n8n-1:/tmp/bi-report-workflow.json
docker exec bi-reports-n8n-1 n8n import:workflow --input=/tmp/bi-report-workflow.json
docker exec bi-reports-n8n-1 n8n publish:workflow --id=BiScheduledReports01
docker compose -p bi-reports restart n8n
```

Set `BI_APP_URL` in `n8n/.env` to the actual BI app port (for example `http://host.docker.internal:3001`), then recreate the service with `docker compose -p bi-reports up -d`. The app must be reachable from Docker. Keep the shared key private. Rebuilding the BI app requires restarting its server.

## How it works

- Each run creates a new report "‹title› · ‹date time›" with fresh results and a summary. Excel and PDF exports are available on the completed procedure report; export files are created when requested. A notification links to the result.
- Stored-procedure reports run in the background; their notification arrives when the procedure finishes.
- Schedules and latest run status are stored in `generated_reports.data.schedule` in the application's database. Each run creates another `generated_reports` row with `scheduledFrom` pointing to the original report.
- Procedure run status and streamed result files are stored under the app's `.data/procedure-runs/<workspace>/<run>/` directory. Notifications are stored under `.data/notifications/`. Back up these directories with the application database.
- n8n keeps successful and failed trigger executions in its own persistent volume. Inspect the workflow's Executions tab to see the BI endpoint's outcomes; a successful HTTP trigger does not itself mean the background procedure has completed.
- A report is never run twice for the same slot, even if n8n calls overlap.
- Procedures that need permission to change data are not run on a schedule.
- Check from your terminal: `curl -X POST -H "x-automation-key: <key>" http://localhost:3000/api/automation/run-due`
