# Ticket insight fix — October 25, 2026

## Confirmed cause

Workspace 32a2cdaf-dd50-40b4-8358-ef738b7d630e is named Ticketing but its selected source 0db057b8-0a78-482b-9c0a-d9666ddebd9d is billGENIXDB.
The saved row tool queries dbo.Tk_TicketInfoMaster with no fixed filters or joins. A direct read-only COUNT_BIG on that table in billGENIXDB returned exactly one record. TicketingDB is separately accessible; the workspace was not switched automatically.

The insight writer bypassed AI for up to five records and serialized every field into the narrative. Assignment/user codes were also eligible numeric measures.

## Fixes

- Small complete detail results now use the insight writer with concise-detail instructions instead of dumping raw fields.
- Opaque ID/code/assignment fields remain in the report but are excluded from small-detail prose input. Missing codes must not be interpreted as missing database data.
- Unsupported workflow-status wording is removed from completed sentences before streaming and from final text unless an explicit matching readable status label exists.
- Single-record comparisons, means and medians are not presented as useful population insights. AI failures show a small-result limitation rather than raw records or misleading averages.
- Assignment/user-code columns are excluded from automatic numeric summaries.
- New query report cards show their actual source database and base table.
- Existing saved replies are not rewritten; new replies use the corrected path.

## Verification

- 238 automated tests passed; TypeScript passed; focused lint passed. The result component has two existing navigation warnings.
- Authenticated chat API on port 3002 returned the correct database/table, one row, no numeric assignment measures, and streaming insight events. Recorded run: 13.926 seconds before the final status-wording guard.
- Initial live testing exposed invented open/unresolved status wording. Added the sentence-level guard and regression coverage rather than relying on prompting alone.
- After explicit user approval to send the saved ticket details to the configured OpenAI model, the final writer test returned concise prose, 77 streamed updates, no raw schema prefixes, and no inferred open/closed/resolved status.
- No source business records or database objects were changed. Normal application test chat messages were saved.
- Current ports 3000 and 3001 belong to other projects. BI dev server is on http://localhost:3002 with BI_INTERNAL_SCHEDULER=off. No unrelated servers or n8n settings were modified.

The remaining source selection is a user decision: keep billGENIXDB or configure TicketingDB and discover/approve its actual tools. A workspace name alone does not select a database.
