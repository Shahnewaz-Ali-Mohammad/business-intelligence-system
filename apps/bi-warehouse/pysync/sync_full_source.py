#!/usr/bin/env python3
"""Full raw mirror of the real production SQL Server databases
(billGENIXDB, TicketingDB) into the SAME warehouse Postgres this project
already runs -- every table, unfiltered, landed as-is into its own schema
(raw_billgenix / raw_ticketing), separate from and never touching the
existing curated star schema (dim_*/fact_* -- see database/warehouse-
schema.sql). That curated schema stays the one the chat agent/Cube query
by default; these raw schemas exist so no table is ever "not synced yet"
-- anything here can be modeled into a real cube later without a new ETL
step first.

Uses dlt (open-source Python ELT library), same engine already used for
per-workspace data-source syncs (see sync_workspace.py) -- zero
hand-written per-table extraction code, same as that pipeline.

Usage:
    python3 sync_full_source.py [billgenix|ticketing|all]

Requires: pip3 install -r requirements.txt (adds pymssql for the SQL
Server source -- a pure-Python driver, no separate ODBC driver install
needed on macOS, unlike pyodbc).

WARNING: BillingMaster alone is a multi-million-row table (confirmed:
fact_billing synced from it at 6.3M+ rows already). A full, first-time,
every-table mirror of both databases is a genuinely large, slow job --
expect this to run for a long time on its first run, not minutes. It is
safe to re-run (write_disposition="replace" per table) and safe to run
one database at a time via the argument above if you want to test with
the smaller one first.
"""
import sys

import os

import dlt
from dlt.sources.sql_database import sql_database
from dlt.common.configuration.specs import ConnectionStringCredentials
from dotenv import load_dotenv

# Running this script directly (python3 pysync/sync_full_source.py) does
# NOT load .env the way `npm run dev:all` does for the Node processes
# (which use --env-file) -- without this, every os.environ[...] lookup
# below fails with a KeyError even though the real values are sitting
# right there in apps/bi-warehouse/.env.
load_dotenv()

def mssql_connection_string(database: str) -> str:
    host = os.environ["SQLSERVER_HOST"]
    port = os.environ.get("SQLSERVER_PORT", "1433")
    user = os.environ["SQLSERVER_USER"]
    password = os.environ["SQLSERVER_PASSWORD"]
    # Switched from pymssql (FreeTDS) to pyodbc + Microsoft's own ODBC
    # Driver 18 -- pymssql failed two different ways against this real
    # server (protocol negotiation, then an unspecified connection
    # failure) even though the exact same credentials/host work fine over
    # the Node mssql/tedious driver (confirmed: full read access to every
    # table, see the schema-access check run earlier). Encrypt=no;
    # TrustServerCertificate=yes here mirrors that same working Node
    # config (trustServerCertificate: true, encrypt: false in
    # src/config/db.mjs) -- not a new/different trust decision.
    import urllib.parse
    odbc_str = (
        f"DRIVER={{ODBC Driver 18 for SQL Server}};"
        f"SERVER={host},{port};DATABASE={database};"
        f"UID={user};PWD={password};Encrypt=no;TrustServerCertificate=yes;"
    )
    return f"mssql+pyodbc:///?odbc_connect={urllib.parse.quote_plus(odbc_str)}"


def warehouse_url() -> str:
    host = os.environ.get("WAREHOUSE_PG_HOST", "localhost")
    port = os.environ.get("WAREHOUSE_PG_PORT", "5432")
    db = os.environ["WAREHOUSE_PG_DATABASE"]
    user = os.environ["WAREHOUSE_PG_USER"]
    password = os.environ["WAREHOUSE_PG_PASSWORD"]
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def sync_database(source_db_env_var: str, dest_schema: str) -> None:
    database = os.environ[source_db_env_var]
    print(f"--- Syncing ALL tables from {database} -> warehouse schema '{dest_schema}' ---", flush=True)

    source = sql_database(mssql_connection_string(database))
    pipeline = dlt.pipeline(
        pipeline_name=f"full_raw_{dest_schema}",
        destination=dlt.destinations.postgres(warehouse_url()),
        dataset_name=dest_schema,
    )
    # "replace" per table on this first real run -- simplest, correct
    # semantics for a full mirror with no incremental cursor configured
    # yet. Re-running this script re-copies everything fresh each time,
    # which is fine for this raw layer's purpose (safety net / full
    # visibility), not meant to be the fast, incremental daily job the
    # curated dim_*/fact_* ETL already is.
    load_info = pipeline.run(source, write_disposition="replace")
    print(load_info, flush=True)


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    if target in ("billgenix", "all"):
        sync_database("SQLSERVER_DB_BILLGENIX", "raw_billgenix")
    if target in ("ticketing", "all"):
        sync_database("SQLSERVER_DB_TICKETING", "raw_ticketing")
    print("Done.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
