// FIX 2026-09-15: /chat is an async Server Component (page.tsx) that
// `await`s getHomeDashboardData() -- a full real-data fetch (revenue
// summary + two timeseries + POP breakdown + ticket metrics + active
// customer count + ticket-type breakdown, several of them real aggregate
// queries over multi-million-row fact tables) -- BEFORE anything renders.
// With no loading.tsx, Next.js had nothing to show during that await, so
// every navigation into /chat (including "Continue this conversation" from
// a session page) looked frozen/blank for however long that fetch took --
// worse right after the Postgres container was just recreated (cold page
// cache, see the shared-memory fix), and not helped by dashboardData()'s
// own 30s in-memory cache, which only speeds up a SECOND identical request.
// This file is Next.js's built-in mechanism for exactly this case: it's
// shown immediately on navigation and swapped out automatically once the
// page's own data finishes loading -- no changes to the data-fetching code
// itself, just real, immediate feedback instead of a dead screen.
export default function ChatLoading() {
  return (
    <main className="flex h-screen items-center justify-center bg-background">
      <div className="flex items-center gap-3 rounded-lg border border-zinc-200/80 bg-white/90 px-5 py-4 shadow-sm">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-rose-700" />
        <p className="text-sm font-medium text-zinc-600">Loading real billing, collection, and ticket data...</p>
      </div>
    </main>
  );
}
