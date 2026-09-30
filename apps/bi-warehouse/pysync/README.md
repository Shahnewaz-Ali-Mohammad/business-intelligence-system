# pysync

One dlt (https://dlthub.com, open source) pipeline, `sync_workspace.py`,
handles every onboarded data source generically -- no per-database code to
write. dlt's `sql_database()` source reflects and loads whatever tables
exist at the given connection string automatically.

## One-time setup (once, on whichever machine runs `npm run dev` for bi-dashboard)

```
pip3 install -r pysync/requirements.txt
```

That's it -- no service to run, no server to keep alive. The Next.js sync
route (app/api/workspaces/[id]/sync/route.ts) calls this script as a
one-off subprocess per sync click; dlt itself is just a library import,
not infrastructure.
