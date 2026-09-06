# Business Intelligence System Architecture

## Product Rules

- The app opens on a curated Home Dashboard.
- The Home Dashboard is loaded from a pre-built layout schema and is never overwritten by prompts.
- Prompts can mutate the current page or create a new generated page.
- Pinned pages default to Live.
- Exports default to Snapshot.
- Every page must visibly show Live, Snapshot, or Freeze state.

## Database Rule

The business/demo database is read-only from the BI application.

- The app must connect using `bi_readonly`.
- The app must not connect using `root`.
- The business database must never receive app writes, updates, deletes, schema migrations, or destructive commands.
- App-owned state such as sessions, audit logs, pinned pages, exports, and snapshots belongs in a separate app database later.

## Demo Data Source

- Database: `ecommerce`
- Engine: XAMPP MariaDB/MySQL
- Safe user: `bi_readonly`
- Privileges: `SELECT` on `ecommerce.*`

## Target Runtime Flow

```text
Next.js/React frontend
  -> LangGraph orchestrator
  -> MCP tool boundary
  -> Cube.js semantic layer
  -> read-only ecommerce database
```

## MVP Flow

For the first demo, the Next.js dashboard reads from a small local read-only API. That API connects to `ecommerce` using `bi_readonly` and contains only SELECT queries. Cube.js, MCP, and LangGraph are added after the dashboard surface is stable.

```text
Dashboard
  -> local read-only API
  -> ecommerce database
```

This is temporary and must preserve the same safety rule: read-only access only.
