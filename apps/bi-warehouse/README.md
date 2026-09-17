# BI Warehouse

ETL sync, semantic metrics layer, and BI service functions for the ISP BI
system. Feeds a PostgreSQL warehouse from the real production databases
(`billGENIXDB` + `TicketingDB` on the shared SQL Server), then serves a
single, consistent set of business metrics to the dashboard, chatbot/MCP
tools, reports, and exports.

## Folder structure

```
db/
  warehouse-schema.sql     Postgres DDL — run this once to create the warehouse

src/
  config/
    db.js                  Source (SQL Server) + destination (Postgres) connections

  etl/                     ONLY this layer ever talks to the source SQL Server
    sync.js                Main entrypoint — run daily
    tables/                One file per source table/group being synced
      billingMaster.js      The important one — splits BillingMaster into
                             fact_billing / fact_collection / fact_refund /
                             fact_adjustment by RefTypeID (confirmed mapping,
                             see file header comment)
      customerMaster.js     -> dim_customer
      referenceTables.js    -> dim_pop, dim_package, dim_status, dim_region
      tickets.js             -> fact_ticket (PLACEHOLDER — needs real column
                               confirmation before production use, see file
                               header)
    lib/
      syncLog.js             etl_sync_log read/write (incremental watermark)
      upsert.js               generic insert-or-update helper

  semantic/
    metrics.js               THE single source of truth for metric formulas.
                             Nothing outside this file should ever write its
                             own version of "total billed" etc.

  services/                 ONLY this layer ever talks to the warehouse for
                             READS. Dashboard/chat/reports/exports all call
                             these functions — never write their own SQL.
    revenueService.js
    ticketService.js

  mcp/
    server.mjs               Real MCP server (named tools: get_revenue_summary,
                             get_revenue_timeseries, get_region_breakdown,
                             get_ticket_metrics) — NOT yet wired into the live
                             dashboard, see file header comment for why.

scripts/
  run-daily-sync.sh          Cron entrypoint — MUST run on a machine with real
                             network access to the production SQL Server.
```

## Layer rule (do not break this)

```
SQL Server (source, read-only)
        |  <- ONLY src/etl/* touches this
        v
Postgres warehouse (fact_*/dim_* tables)
        |  <- ONLY src/semantic/* + src/services/* touch this for reads
        v
src/services/*.js  (the ONLY place business logic/SQL for "what does this
                     metric mean" lives)
        |
        +--> src/mcp/server.mjs     (chatbot — once wired in, see file header)
        +--> dashboard routes       (wire these to call services/* directly)
        +--> report generator       (same)
        +--> CSV/PDF export         (same)
```

If you ever find yourself writing a SQL query outside `src/etl/*` or
`src/services/*`, stop — it belongs in one of those two places instead.

## Setup

1. `cp .env.example .env` and fill in real credentials.
2. Create the Postgres database, then run the schema:
   ```
   psql "$WAREHOUSE_PG_CONNECTION_STRING" -f ../database/warehouse-schema.sql
   ```
3. `npm install`
4. Test one sync run manually: `npm run sync`
5. Once it runs clean, set up the cron job (see `scripts/run-daily-sync.sh`)
   on a server with real network access to the production database — this
   will NOT run from an isolated/sandboxed environment.

## Known open items before this is fully production-ready

See `claude/full-project-context.md` (the project's running decision log)
for the full list, but the two that block real use:

1. **`tickets.js` is a placeholder** — the real TicketingDB ticket table
   (and whether multiple channel tables need unioning, similar to how
   collection turned out to need multiple payment-channel tables) was
   never confirmed against real row samples.
2. **`PackageMaster` / `dim_region` column names in `referenceTables.js`**
   are taken from the schema dump, not verified against a real
   `SELECT TOP 20 *` — double check before relying on them.

Everything in `billingMaster.js` and `customerMaster.js` IS verified
against real data (see project doc section 3.7).
