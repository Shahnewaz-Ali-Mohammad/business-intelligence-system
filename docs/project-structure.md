# Project Structure

```text
Business Intelligence System/
  apps/
    bi-dashboard/          Web dashboard application
      app/                 Routes and app shell
      components/          Reusable UI and dashboard components
      lib/                 Dashboard schemas, data access, shared helpers
      public/              Static assets
  database/
    imports/               Database import files and compatibility scripts
  docs/                    Architecture and setup notes
  ecommerce-xampp.sql      XAMPP-compatible demo import file
```

## Current Focus

The first implementation focuses on the home dashboard and clean app structure. The app is prepared for:

- curated dashboard schemas
- generated page history
- pinned page state
- live/snapshot export behavior
- read-only database access
- later Cube.js/MCP/LangGraph integration
