#!/usr/bin/env python3
"""Per-workspace sync job -- copies tables from a newly onboarded data
source's own database into that workspace's own schema
(workspace_<id>) inside the SAME warehouse Postgres database this project
already runs (WAREHOUSE_PG_* -- see src/config/db.mjs), using dlt
(https://dlthub.com), an open-source Python ELT library, not custom
extraction code per data source.

This is the ONLY code path that reads a newly onboarded source database.
Nothing else (the AI draft step, Cube, chat) ever queries it directly --
matches the existing ISP system's own rule that the source database is
never queried live outside the ETL layer (see src/etl/sync.mjs's own
header comment).

Usage:
    python3 sync_workspace.py <workspace_id> <source_connection_string> <dialect>

Prints one JSON line to stdout on success and exits 0; prints the error to
stderr and exits non-zero on failure, so the calling Node route
(app/api/workspaces/[id]/sync/route.ts) can parse either outcome.

Requires: pip3 install -r requirements.txt (one-time, on whichever machine
actually runs `npm run dev` for bi-dashboard -- see pysync/README.md).
"""
import json
import os
import sys

import dlt
from dlt.sources.sql_database import sql_database


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: sync_workspace.py <workspace_id> <connection_string> <dialect>", file=sys.stderr)
        return 2

    workspace_id, connection_string, dialect = sys.argv[1], sys.argv[2], sys.argv[3]

    if dialect != "postgres":
        # MySQL/SQL Server/Oracle sources: dlt's sql_database() source
        # already supports them (it uses SQLAlchemy under the hood) -- this
        # guard exists only because introspectPostgres.mjs (the schema-read
        # step) is Postgres-only for now, so a non-Postgres source would
        # never have gotten a confirmed model to sync against anyway. Lift
        # this guard once that introspection step covers other dialects too.
        print(f"sync for dialect '{dialect}' isn't reachable yet -- introspection only supports postgres so far", file=sys.stderr)
        return 2

    destination_schema = f"workspace_{workspace_id}"

    warehouse_url = (
        f"postgresql://{os.environ['WAREHOUSE_PG_USER']}:{os.environ['WAREHOUSE_PG_PASSWORD']}"
        f"@{os.environ['WAREHOUSE_PG_HOST']}:{os.environ.get('WAREHOUSE_PG_PORT', '5432')}"
        f"/{os.environ['WAREHOUSE_PG_DATABASE']}"
    )

    pipeline = dlt.pipeline(
        pipeline_name=f"workspace_{workspace_id}_sync",
        destination=dlt.destinations.postgres(warehouse_url),
        dataset_name=destination_schema,
    )

    # sql_database() reflects every table in the source connection and
    # loads them -- this is the generic, schema-agnostic sync this project
    # needs: no hand-written per-business extraction code, unlike the
    # existing ISP-specific src/etl/sync.mjs (which is fine to stay
    # hand-written, since it deals with real known quirks like the
    # RefTypeID split -- see database/warehouse-schema.sql).
    source = sql_database(connection_string)
    load_info = pipeline.run(source, write_disposition="merge")

    print(json.dumps({
        "workspaceId": workspace_id,
        "destinationSchema": destination_schema,
        "loadPackages": [str(pkg) for pkg in load_info.load_packages],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
