# Scheduled reports with n8n

The BI app keeps the schedules: open a saved workspace report → **Schedule** → choose daily, weekly or monthly and a time.
n8n only triggers the check: every 5 minutes it calls the BI app, which runs every report that is due, saves the result as a new report and shows a notification (bell, top-left).

## One-time setup

1. Create a key: `openssl rand -hex 32`
2. Add it to `apps/bi-dashboard/.env.local`:
   `AUTOMATION_API_KEY=<key>`, then restart the BI app.
3. `cp n8n/.env.example n8n/.env` and set `BI_AUTOMATION_KEY=<same key>`.
4. Start n8n: `cd n8n && docker compose up -d`
5. Open http://localhost:5678, create the n8n owner account.
6. **Workflows → Import from file →** `n8n/workflows/run-scheduled-reports.json`, then switch the workflow **Active**.

## How it works

- Each run creates a new report "‹title› · ‹date time›" with the full result, summary and Excel export, and a notification links to it.
- Stored-procedure reports run in the background; their notification arrives when the procedure finishes.
- A report is never run twice for the same slot, even if n8n calls overlap.
- Procedures that need permission to change data are not run on a schedule.
- Check from your terminal: `curl -X POST -H "x-automation-key: <key>" http://localhost:3000/api/automation/run-due`
