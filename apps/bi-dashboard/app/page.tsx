// The Home Dashboard UI (KPI cards, charts, tables) is deliberately removed
// here, 2026-09-15, per explicit direction: it kept surfacing noisy
// non-fatal React "duplicate key" warnings from list rendering, and the
// team wants to focus effort on the chat/analytics (AI chat + MCP
// warehouse tools) path instead of the dashboard visualization path for
// now. The underlying data layer (scripts/lib/dashboard-data.mjs) is left
// intact and working (verified against real warehouse numbers) in case the
// dashboard UI is revisited later -- only this route's rendering is
// disabled, nothing about the real data pipeline was deleted.
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/chat');
}
