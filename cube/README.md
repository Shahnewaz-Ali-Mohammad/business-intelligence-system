# Cube (semantic layer) -- open source, not custom code

This is the real, official Cube (cube.dev) project running as a Docker
container -- nothing here is hand-written query logic.

## One-time setup

```
cd cube
cp .env.example .env
# fill in the same WAREHOUSE_PG_* values as apps/bi-warehouse/.env,
# and generate CUBEJS_API_SECRET with: openssl rand -hex 32
docker compose up -d
```

Cube's playground is then at http://localhost:4001 -- you can browse any
confirmed workspace's model there directly, no code needed.

## How it connects to the rest of this project

- **Data**: the same warehouse Postgres database apps/bi-warehouse already
  uses, scoped per workspace via each source table's `workspace_<id>`
  schema (written by pysync/sync_workspace.py).
- **Model**: `model/workspaces/<id>.yml`, written automatically whenever a
  data source's AI-drafted semantic model is confirmed in the Data Sources
  UI (POST /api/workspaces/[id]/confirm-model). Cube's own model loader
  picks these up with zero code from this project.
- **Exposing it to chat**: Cube ships its own official MCP server
  (`@cubejs-backend/mcp-server`, open source) -- run it with:
  ```
  npx -y @cubejs-backend/mcp-server
  ```
  pointed at this Cube instance's API URL + CUBEJS_API_SECRET, and it
  exposes `searchDataModel` / `runQuery` tools automatically. Wiring the
  existing chat agent (apps/bi-dashboard/scripts/chat/agent.mjs) to call
  those tools for a non-ISP workspace is the next step once this container
  is actually running -- not yet done, since it depends on Cube being live
  first.
