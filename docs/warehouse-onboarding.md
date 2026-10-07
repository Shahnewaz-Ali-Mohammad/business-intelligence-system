# Warehouse Onboarding

## User Flow

Open Data Sources, add a named connection, and open it. Select the existing
PostgreSQL warehouse or enter another approved PostgreSQL connection URL.
Connect, select schemas, discover tables, review eligible tables and proposed
relationships, then Validate and Activate. Open Chat from that connection.

For the ticketing mirror choose `raw_ticketing`. No additional copy or source
SQL Server access is needed. Start with Tk_TicketInfoMaster, Tk_TicketType,
Tk_TicketStatus, and whichever related business tables are needed. The mirror
has no enforced PostgreSQL FKs: proposed relationships require explicit review.
The generator deliberately does not approve matching column names by itself.

## Implementation

- PostgreSQL metadata discovery uses pg_catalog, schema-qualified identifiers,
  declared composite PKs/FKs and read-only transactions. No sample customer
  rows or per-column full-table scans are used during onboarding.
- Deterministic Cube YAML generation exposes approved scalar dimensions, counts,
  and mathematical numeric aggregates. It does not guess business definitions.
  Stable short names respect PostgreSQL's 63-byte alias limit.
- Declared FKs are activated only with an established unique target PK. Other
  candidate relationships require review. Multiple relationships to the same
  target need separate role models and are omitted with warnings, not guessed.
- Activation compiles the model and runs a bounded Cube test before atomically
  replacing the active connection and model. Failed drafts preserve the old
  confirmed connection. No YAML editing is required in the new UI.
- Cube repositoryFactory/driverFactory select models and connections using
  signed owner/workspace/version claims. Compiler, query and connection caches
  are isolated per model version and between preview and live contexts.
- A server-only bridge validates short-lived signed claims and ownership before
  supplying Cube with credentials. Credentials are AES-GCM encrypted at rest,
  not sent to the browser, the AI, or stored in model files. Connection identity
  uses a server-keyed fingerprint rather than a guessable password hash.
- Chat selects relevant tables, reads bounded reference dictionaries and plans
  a schema-constrained query object. The application validates fields, filter
  operators, grains and approved joins before Cube runs it. Raw AI SQL is never
  executed. One query-repair attempt is permitted; otherwise clarification is
  returned rather than inventing a query or an empty result.
- Whole-population counts and available lookup breakdowns ground insights.
  The AI sees at most five bounded preview rows plus aggregates, not the entire
  result set. Reference dictionaries are capped at 100 entries and explicitly
  marked incomplete when capped. Only relevant tables and one-hop lookups are
  included in planning; ambiguous business metrics still need definitions.
- Chat stays at 200 results; saved report pages stay at 100. Pagination and
  Excel exports retain the workspace/model identity and query. Reports are live
  query-backed, not immutable full-table snapshots. Model version mismatches
  fail closed instead of executing against a replacement warehouse.
- Conversation metadata persists warehouse identity before the first report.
  Removing a connection does not silently redirect its chats to the legacy DB.
- Schema fingerprints are checked on use, cached for up to 60 seconds. Changes
  require rediscovery/review/activation; added columns are not exposed silently.
  No background schema migration, source replication or scheduler is introduced.
- Graph functionality remains disabled. Legacy ISP Cube models remain available
  and their PK fields explicitly public for existing record reports.

## Deployment

Set WORKSPACE_SECRETS_KEY to an existing stable 32-byte hex encryption key.
Changing it without migrating encrypted connection strings makes them unreadable.
Set WORKSPACE_ALLOWED_HOSTS to a comma-separated allowlist of approved database
hosts; localhost, 127.0.0.1 and the configured warehouse host are the defaults
when no explicit allowlist is supplied. URL driver options are restricted.
Use a SELECT-only database account in production; the connector additionally
enforces default_transaction_read_only and bounded statement/connection timeouts.
Sensitive-column/table name screening is a baseline, not a substitute for DB
grants and a reviewed business-table allowlist. Free-text columns can contain
personal information: do not approve them blindly for external AI use.

Apply the additive conversation migration from apps/bi-dashboard:

```sh
node --env-file=.env.local database/apply-warehouse-onboarding.mjs
```

It needs SCHEMA_ADMIN_USER/SCHEMA_ADMIN_PASSWORD with ALTER privileges. It is
also included in the main bi_app_schema.sql for new deployments.

Reload Cube with its new mounted cube.js:

```sh
docker compose -f cube/docker-compose.yml --env-file cube/.env up -d
```

Cube authentication is enabled and its API binds to localhost. Cube and Next
must share CUBEJS_API_SECRET. WORKSPACE_BRIDGE_URL defaults to
http://host.docker.internal:3000/api/internal/warehouse; set it to the internal
dashboard address in other deployments. Localhost PostgreSQL connections are
translated to host.docker.internal inside Cube's container. TLS modes require
certificate validation; self-signed deployments need a trusted certificate.

This single-instance deployment uses Cube's memory cache/queue and no rollups.
Configure Cube Store before horizontal scaling or enabling pre-aggregations.
Only PostgreSQL warehouses are supported by this onboarding flow. Other
database engines need their own introspection and driver adapters.

## Verification

```sh
# In apps/bi-warehouse
node --test src/semantic/warehouseModel.test.mjs
# In apps/bi-dashboard, with dashboard and Cube running
node --env-file=.env.local scripts/check-warehouse-onboarding.mjs
TEST_TICKETING=1 node --env-file=.env.local scripts/check-warehouse-onboarding.mjs
# No AI requests: activation, ownership, and real ticket counts only
TEST_LOCAL_ONLY=1 TEST_TICKETING=1 node --env-file=.env.local scripts/check-warehouse-onboarding.mjs
```

The integration suite uses disposable synthetic tables and temporary accounts
created through the normal registration API, and cleans them up in finally.
It tests full lists, category filters, exact and missing IDs, numeric/date
filters including nested OR, top-N, owner isolation, stale-model rejection,
saved report identity, 100-row paging, full Excel export, connection choice,
session identity and failed activation preserving the old model. Setup staging
uses a fingerprint comparison so large inventories do not send the full
schema twice or replace a newer draft while validation is running.
The optional ticketing branch reads real warehouse counts through local Cube
only: it does not send real rows, labels, counts or schema to external AI.
Real-data AI testing requires separate approval. Synthetic AI tests validate
the pipeline but cannot establish that every possible natural-language request
will always be interpreted correctly.
