// Deterministic chart-type picker: turns a ReportTable (the exact same
// headers/rows the table view already renders) into a small "chart spec"
// describing how to draw it -- never a finished chart. This runs on plain
// table shape, not on the AI's own judgement, so the same table always
// produces the same chart choice, and mismatched-scale measures (e.g.
// revenue in the millions next to a customer count in the hundreds) never
// get forced onto one axis.
//
// See project decision log for the full reasoning behind this approach.

export type ReportTable = { headers: string[]; rows: (string | number)[][] };

export type ChartKind = 'bar' | 'line' | 'donut' | 'grouped-bar' | 'none';

export type ChartGroup = {
  kind: ChartKind;
  // Index into headers/rows for the label column (x-axis / slice labels).
  dimensionIndex: number;
  // The FULL, canonical set of measure columns available to this chart
  // group -- e.g. both "Total Billed" and "Total Collected". This never
  // shrinks as a result of an edit (picking Donut, toggling a measure
  // chip off). A prior bug overwrote this with whatever subset was
  // CURRENTLY being drawn (e.g. just one measure, once Donut was picked),
  // which permanently deleted the other measure from the saved chart --
  // switching back to Bar/Line afterward had nothing left to plot a
  // second series from. `hiddenMeasureIndices` below is where a
  // display-only narrowing belongs instead.
  measureIndices: number[];
  // Which of `measureIndices` the user has toggled OFF (via the measure
  // chips). Persisted so a saved/reopened chart shows the same measures
  // the user last chose -- but, critically, this is the ONLY thing an
  // edit is allowed to change; `measureIndices` itself always stays
  // intact. A Donut view's forced single-measure narrowing is computed at
  // render time from this + the chart's own "only one series fits" rule;
  // it is never written back here either.
  hiddenMeasureIndices: number[];
  // Which single measure the Donut view is currently showing (Donut can
  // only ever plot one series -- see the field above for why that
  // narrowing must live in its own field rather than shrinking
  // `measureIndices`). Persisted so a reopened chart keeps the same
  // metric selected instead of silently resetting to whichever measure
  // happens to be first. Undefined means "no explicit choice yet" -- the
  // component picks a sensible default (the first measure that's never
  // negative, since a donut can't render a negative share of the whole).
  donutMeasureIndex?: number;
  // Base label only (e.g. "Total Billed vs Total Collected") -- NEVER
  // includes a "(top N of M)" suffix. That suffix depends on the
  // currently-selected row limit, which changes via the row-count editor
  // independently of this spec, so it's computed live at render time
  // instead of being baked in here (a prior bug baked it in once at
  // generation time, so it silently went stale/wrong the moment the user
  // picked a different "Top N").
  title: string;
  // Row indices (into the ORIGINAL table.rows, already Totals-stripped)
  // that this chart actually draws. Almost always every row; capped to
  // the first N when the table has more rows than a chart can show
  // legibly (data is already ordered by the service layer, so "first N"
  // means "top N" for most breakdowns). The table itself always shows
  // every row regardless -- only the chart is capped.
  rowIndices: number[];
  truncated: boolean;
};

export type ChartSpec = {
  // Usually one group. More than one means "small multiples" -- measures
  // that don't share a scale, rendered as separate stacked mini-charts
  // instead of one misleading combined chart.
  groups: ChartGroup[];
};

export const MAX_BAR_ROWS = 20;
export const MAX_LINE_ROWS = 60;
export const MAX_DONUT_SLICES = 6;
export const MAX_MULTISERIES_COLUMNS = 5;

// Row-count choices offered by the chart's "Show top N" control -- shared
// here so the picker's own default cap and the editable control always
// agree on the same option set instead of drifting apart.
export function getRowLimitOptions(totalRows: number, isTimeSeries: boolean): number[] {
  const base = isTimeSeries ? [10, 20, MAX_LINE_ROWS] : [5, 10, MAX_BAR_ROWS, 50];
  const options = base.filter((n) => n < totalRows);
  options.push(totalRows);
  return Array.from(new Set(options)).sort((a, b) => a - b);
}

export function isDateLikeHeader(header: string): boolean {
  return /day|date|month|week/i.test(header);
}

function columnMagnitude(rows: (string | number)[][], colIndex: number): number {
  let max = 0;
  for (const row of rows) {
    const v = row[colIndex];
    if (typeof v === 'number') max = Math.max(max, Math.abs(v));
  }
  return max;
}

// Buckets measure column indices by order of magnitude so a revenue column
// (millions) is never grouped with a count column (tens/hundreds) on one
// chart. Columns within ~2 orders of magnitude of each other share a
// bucket; anything further apart splits into its own bucket.
function bucketByScale(rows: (string | number)[][], measureIndices: number[]): number[][] {
  const withMagnitude = measureIndices
    .map((i) => ({ i, mag: columnMagnitude(rows, i) }))
    .sort((a, b) => a.mag - b.mag);

  const buckets: number[][] = [];
  for (const { i, mag } of withMagnitude) {
    const last = buckets[buckets.length - 1];
    if (!last) {
      buckets.push([i]);
      continue;
    }
    const lastMag = Math.max(...last.map((j) => columnMagnitude(rows, j)), 1);
    const ratio = mag === 0 ? 1 : mag / Math.max(lastMag, 1);
    // Same bucket if within roughly two orders of magnitude of the
    // bucket's current max; otherwise it starts a new bucket.
    if (ratio <= 100) {
      last.push(i);
    } else {
      buckets.push([i]);
    }
  }
  return buckets;
}

/**
 * Picks a chart spec for a ReportTable that's already had its Totals row
 * (if any) stripped by the caller. Returns { groups: [] } (kind 'none')
 * when no sensible chart exists for this shape -- the table alone is the
 * honest answer at that point, not a forced/unreadable chart.
 */
export function getChartSpec(table: ReportTable): ChartSpec {
  const { headers, rows } = table;
  if (!headers.length || !rows.length) return { groups: [] };

  // Column 0 is always the identifying/dimension column by report-table.ts
  // convention (POP ID, Package, Customer, Ticket Type, Day, Name, ...).
  const dimensionIndex = 0;
  const dimensionHeader = headers[0];
  const isTimeSeries = isDateLikeHeader(dimensionHeader);

  const measureIndices: number[] = [];
  for (let i = 1; i < headers.length; i++) {
    const hasNumeric = rows.some((row) => typeof row[i] === 'number');
    if (hasNumeric) measureIndices.push(i);
  }
  if (!measureIndices.length) return { groups: [] };

  const rowCount = rows.length;
  const maxRowsForShape = isTimeSeries ? MAX_LINE_ROWS : MAX_BAR_ROWS;

  // Too many measure columns to make sense of at once (e.g. a wide
  // transaction-mode-by-POP cross table with 8+ mode columns) -- table
  // only, no forced chart.
  if (measureIndices.length > MAX_MULTISERIES_COLUMNS * 2) {
    return { groups: [] };
  }

  const scaleBuckets = bucketByScale(rows, measureIndices);

  const groups: ChartGroup[] = scaleBuckets.map((bucketIndices) => {
    const singleMeasure = bucketIndices.length === 1;
    const truncated = rowCount > maxRowsForShape;
    // FIX: this used to suppress the chart entirely (kind = 'none') once a
    // table had more rows than a chart can show legibly, e.g. a 40-package
    // table silently never got a chart at all even though the table
    // itself was fine. Now it charts the top maxRowsForShape rows instead
    // of hiding the chart -- the table below still shows every row, only
    // the chart is capped, and the title says so.
    const rowIndices = truncated
      ? Array.from({ length: maxRowsForShape }, (_, i) => i)
      : rows.map((_, i) => i);

    let kind: ChartKind;
    if (isTimeSeries) {
      kind = 'line';
    } else if (singleMeasure && rowCount <= MAX_DONUT_SLICES && scaleBuckets.length === 1 && measureIndices.length === 1) {
      // Only offer donut when it's truly one dimension / one measure with
      // few slices -- a natural "share of whole" shape. Multi-measure or
      // multi-bucket tables stay bar, since a donut can't show more than
      // one series meaningfully.
      kind = 'donut';
    } else if (bucketIndices.length > 1 && bucketIndices.length <= MAX_MULTISERIES_COLUMNS) {
      kind = 'grouped-bar';
    } else {
      kind = 'bar';
    }

    const baseTitle = bucketIndices.map((i) => headers[i]).join(' vs ');

    return {
      kind,
      dimensionIndex,
      measureIndices: bucketIndices,
      hiddenMeasureIndices: [],
      donutMeasureIndex: undefined,
      title: baseTitle,
      rowIndices,
      truncated,
    };
  });

  return { groups };
}
