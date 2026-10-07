# TicketingDB Raw Warehouse Copy

## Verified October 5, 2026

- 209 base tables, including empty tables.
- 2,604 columns and 22,406,827 rows in `raw_ticketing` (5,240 MB).
- 11 SQL Server view definitions captured separately.
- Every destination count and ordered column list independently verified.
- Five complete source records compared in each of six core tables:
  tickets, customers, notes, history, statuses and categories.
- No table-copy failures, no source row-count changes during extraction,
  and no staging tables left behind.

The main ticket table has 173,061 rows and 46 columns. Its LinkId values
match the source: four populated ticket rows and three distinct link IDs.
These raw tables have not yet been added to the chatbot's semantic model.

Run from `apps/bi-warehouse`:

```sh
node --env-file=.env scripts/copy-ticketing-db.mjs
node --env-file=.env scripts/verify-ticketing-copy.mjs
```

The copy is restricted to the configured `TicketingDB` source. All readable
base tables, including empty tables, history, temporary and authentication
tables, are copied into `raw_ticketing`. Original table and column names
are preserved and must be quoted when they contain uppercase characters.
The existing `public.dim_*` / `public.fact_*` tables and workspace schemas
are not modified. Copying raw data does not automatically expose it to Cube
or the chatbot. Authentication, passwords, tokens, OTPs and customer personal
data must not be indiscriminately added to an AI-accessible model.

`raw_ticketing_meta.table_copies` records source column definitions, source
primary keys and declared foreign-key relationships, extracted row counts,
source counts before/after the read, and completion times. Primary keys are
recreated; other indexes, defaults, identity generation, triggers and stored
procedures are not recreated. The source's 11 view definitions are captured
in `raw_ticketing_meta.source_views`, not executed as PostgreSQL SQL.

Each table is streamed into a transactional staging table with bounded
memory, then counted and published atomically. Decimal and bigint values
are extracted as strings to prevent Javascript numeric rounding. Database
timestamps are extracted as strings rather than Javascript dates. Nulls,
empty strings, Unicode and escaped text remain distinct. Unsupported types,
unrepresentable NUL text and date precision beyond PostgreSQL's capabilities
cause a reported failure instead of a silent lossy conversion.

This source has snapshot isolation disabled. Reads use the existing source
read-committed behavior without NOLOCK or source configuration changes.
The copy is a per-table live extract, not a consistent database-wide backup.
Source counts before/after copying expose row-count changes; unchanged counts
do not prove no updates occurred while a table was read.
The verification command checks every copied table's count and ordered
columns, then compares complete sampled records in the main ticket,
customer, notes, history, status and type tables without printing row data.

Rerunning resumes completed checkpoints after verifying their destination
counts and schema fingerprints. Resume does not infer unchanged content from
equal counts, and does not refresh completed tables. To explicitly recopy:

```sh
node --env-file=.env scripts/copy-ticketing-db.mjs --refresh
node --env-file=.env scripts/copy-ticketing-db.mjs --tables=Tk_TicketInfoMaster --refresh
```

Existing raw tables without a copy checkpoint are never overwritten. A
database advisory lock prevents simultaneous mirror jobs. Failed tables are
reported with a nonzero exit status while other tables can complete.

```sql
SELECT source_table, row_count, jsonb_array_length(columns) AS columns,
       completed_at, source_rows_before, source_rows_after
FROM raw_ticketing_meta.table_copies
ORDER BY source_table;

SELECT COUNT(*) FROM raw_ticketing."Tk_TicketInfoMaster";
```
