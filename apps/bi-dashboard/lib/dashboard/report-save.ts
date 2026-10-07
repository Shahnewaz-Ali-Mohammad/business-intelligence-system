// Shared by both ways a report gets saved -- the chat panel's own "Save
// Report" (app/api/reports/route.ts) and the report detail page's
// "Regenerate" follow-up (app/api/reports/[id]/regenerate/route.ts).
// Pulled out of the reports route so both save paths cap row-level data
// the SAME way instead of maintaining two copies that could drift.
//
// FIX 2026-10-01 (original note, unchanged): Save Report serialized
// `data` whole, with no size awareness at all. For an aggregate breakdown
// (dozens of rows) that's trivial, but data.ticketList/customerList/
// semanticQueryTable.rows can now legitimately be up to 5,000 rows (see
// getTicketList's own comment), and stuffing a multi-thousand-row JSON
// blob into a single MySQL TEXT/JSON column on every save is exactly the
// kind of thing that makes saving feel slow or fail outright for no
// visible reason. A saved report is a snapshot for later reference, not
// the system's export mechanism (that's the dedicated CSV/Excel export,
// already unbounded and built for this) -- so this caps any row-array
// field in `data` at SAVE_ROW_CAP before it's ever written, walking every
// array property on `data` generically (not a per-topic list to
// maintain) so this applies uniformly to ticketList, customerList,
// semanticQueryTable.rows, or any future row-level field without another
// hand-written case.
// 2026-10-04: was 2000, which silently cut a saved report below what the
// live chat showed (the "50 of 2,001" = 2,000 rows + notice row). Now
// matches the warehouse's own hard cap (MAX_ROWS in ticketService.mjs /
// customerService.mjs) so a saved report keeps exactly what was shown.
// 2026-10-04: no truncation -- a saved report keeps EVERY row it was
// generated with. Only the chat view is limited (200 rows).
export const SAVE_ROW_CAP = Number.POSITIVE_INFINITY;

export function capRowArraysForSave<T>(value: T): { capped: T; wasTruncated: boolean } {
  let wasTruncated = false;
  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      const truncatedHere = node.length > SAVE_ROW_CAP;
      if (truncatedHere) wasTruncated = true;
      const limited = truncatedHere ? node.slice(0, SAVE_ROW_CAP) : node;
      return limited.map(walk);
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(val);
      }
      return out;
    }
    return node;
  }
  return { capped: walk(value) as T, wasTruncated };
}
