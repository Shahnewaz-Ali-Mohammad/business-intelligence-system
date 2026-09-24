'use client';

// Generic chart renderer driven purely by a ChartSpec + the same
// ReportTable the table view already shows -- so chart and table can
// never disagree, and this works for ANY topic's table shape without a
// hardcoded per-topic chart component. Each chart also carries its own
// lightweight EDIT controls (chart type, which measures are shown, how
// many rows) -- the auto-picked spec is a sensible default, never a
// locked-in choice; the user can always override it in place.
import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, LineChart as LineChartIcon, PieChart as PieChartIcon } from 'lucide-react';
import {
  getRowLimitOptions,
  isDateLikeHeader,
  type ChartGroup,
  type ChartKind,
  type ChartSpec,
  type ReportTable,
} from '@/lib/dashboard/chart-spec';

// Fixed categorical order -- never cycled/regenerated per render, so a
// given measure keeps the same color across edits and reopens.
const SERIES_COLORS = ['#2563eb', '#0f9f9a', '#d97706', '#7c3aed', '#e11d48'];

// A donut's slices are DIMENSION values (POP, package, ...), not a fixed
// small set of measures -- a package breakdown can have 70+ slices, and
// cycling the 5-color SERIES_COLORS list would repeat the same color
// every 5 slices, making adjacent wedges indistinguishable. Past that
// small-N case, spread hues evenly around the wheel instead so every
// slice (and its legend swatch) stays visually distinct.
function sliceColor(i: number, total: number): string {
  if (total <= SERIES_COLORS.length) return SERIES_COLORS[i % SERIES_COLORS.length];
  const hue = Math.round((360 * i) / total);
  return `hsl(${hue}, 62%, 50%)`;
}

// The Y axis used to print raw numbers (630780.8611, 66000000, ...) with
// no formatting, so any BDT-scale figure came out as a long
// "0000000"-looking string the fixed axis-tick column was too narrow to
// fit -- it visually got clipped. Compact notation (631K, 66M) is always
// short enough to fit; the Tooltip still shows the real, un-rounded number
// on hover, so nothing is hidden, only the axis label is shortened.
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
function formatAxisTick(value: number | string): string {
  return typeof value === 'number' ? compactNumber.format(value) : String(value);
}

// recharts silently DROPS overlapping X-axis tick labels by default
// (interval="preserveStart" behavior) -- interval={0} forces every label
// to attempt rendering. That alone still lets angled labels visually
// OVERLAP once there are many categories squeezed into one fixed-width
// container, which the per-category minimum width below solves.
const X_AXIS_PROPS = {
  tickLine: false as const,
  axisLine: false as const,
  fontSize: 11,
  interval: 0 as const,
  angle: -35,
  textAnchor: 'end' as const,
  height: 70,
};
const MIN_PX_PER_CATEGORY = 76;

type GroupOverride = {
  kind: ChartKind;
  hiddenMeasures: Set<number>;
  rowLimit: number;
  // Which measure the Donut view plots -- a DEDICATED choice, independent
  // of the show/hide chips (those apply to Bar/Line's multiple series;
  // Donut can only ever show one, so it gets its own selector instead of
  // making the user hide every other measure just to pick which one it
  // draws).
  donutMeasureIndex: number;
};

function toChartRows(
  table: ReportTable,
  dimensionIndex: number,
  measureIndices: number[],
  rowLimit: number,
) {
  // "Top N" = the first N rows of the table, which is already ordered by
  // the service layer (billed/collected/etc. descending) for every real
  // breakdown -- so this matches what "top packages", "top POPs" etc.
  // already mean elsewhere in the app.
  return table.rows.slice(0, rowLimit).map((row) => {
    const point: Record<string, string | number> = { __label: String(row[dimensionIndex]) };
    for (const i of measureIndices) {
      const v = row[i];
      point[table.headers[i]] = typeof v === 'number' ? v : 0;
    }
    return point;
  });
}

const KIND_OPTIONS: { kind: ChartKind; label: string; icon: typeof BarChart3 }[] = [
  { kind: 'bar', label: 'Bar', icon: BarChart3 },
  { kind: 'line', label: 'Line', icon: LineChartIcon },
  { kind: 'donut', label: 'Donut', icon: PieChartIcon },
];

function ChartGroupCard({
  table,
  group,
  onChange,
}: {
  table: ReportTable;
  group: ChartGroup;
  // Reports the EFFECTIVE group (after the user's own overrides) back to
  // the parent whenever it changes -- this is how an edit made here (chart
  // type, hidden measures, row limit) becomes something the Reports page
  // can actually save. Optional: the chat panel doesn't pass it, since
  // edits there are session-only by design (persisting happens on the
  // saved report, not mid-conversation).
  onChange?: (group: ChartGroup) => void;
}) {
  const isTimeSeries = isDateLikeHeader(table.headers[group.dimensionIndex] ?? '');
  const rowLimitOptions = getRowLimitOptions(table.rows.length, isTimeSeries);

  // A donut slice can't represent a negative share of the whole (see the
  // longer note further down) -- so the default measure it opens with
  // should be the first one that's never negative in this data, not just
  // "whichever measure happens to be listed first" (which, for a table
  // like Outstanding/Collected/Billed, would default to the one measure
  // most likely to actually be negative for some rows).
  function measureHasNegatives(measureIndex: number): boolean {
    return table.rows.some((row) => {
      const v = row[measureIndex];
      return typeof v === 'number' && v < 0;
    });
  }
  const defaultDonutMeasure = group.measureIndices.find((i) => !measureHasNegatives(i)) ?? group.measureIndices[0];

  const [override, setOverride] = useState<GroupOverride>({
    // 'grouped-bar' is just a bar chart with >1 series -- collapse it to
    // 'bar' for the editable kind so the type switcher only ever shows
    // three real choices.
    kind: group.kind === 'grouped-bar' ? 'bar' : group.kind,
    // Restore any previously-saved toggle state instead of always
    // starting fresh -- a reopened report should show the same measures
    // the user last chose, not silently reset to "everything visible".
    hiddenMeasures: new Set(group.hiddenMeasureIndices ?? []),
    rowLimit: group.rowIndices.length,
    donutMeasureIndex: group.donutMeasureIndex ?? defaultDonutMeasure,
  });

  const totalRows = table.rows.length;
  const visibleMeasures = group.measureIndices.filter((i) => !override.hiddenMeasures.has(i));
  // Donut's measure comes from its OWN dedicated selector (override.donutMeasureIndex),
  // not from whatever the show/hide chips currently leave visible -- those
  // chips are a separate control for Bar/Line's multiple series. This
  // narrowing to one measure is PURELY a rendering choice, computed fresh
  // every render -- it must never be written back as the group's real
  // `measureIndices` (that was the earlier bug: picking Donut used to
  // permanently delete every measure but this one from the saved chart,
  // so switching back to Bar/Line had only one series left to draw).
  const donutMeasure = override.donutMeasureIndex;
  const measuresForChart = override.kind === 'donut' ? [donutMeasure] : visibleMeasures.length ? visibleMeasures : group.measureIndices;

  const chartRows = toChartRows(table, group.dimensionIndex, measuresForChart, override.rowLimit);
  const measureHeaders = measuresForChart.map((i) => table.headers[i]);
  // A donut/pie slice's angle is that row's share of the SUM of the whole
  // series -- a value like "Outstanding" can be negative (a customer who
  // overpaid, i.e. a credit balance), and there is no valid slice angle
  // for a negative share of a whole. recharts doesn't error on this, it
  // just silently produces zero-size/invalid arcs, which is why the donut
  // rendered as a totally empty circle instead of any visible error. Bar
  // and line have no such restriction (a bar can dip below the zero
  // line), so this only ever blocks the Donut view, never the data itself.
  const donutMeasureHasNegatives = override.kind === 'donut' && measureHasNegatives(donutMeasure);
  const showingAll = override.rowLimit >= totalRows;
  // The visible title always reflects the CURRENT row limit, computed live
  // -- group.title is only ever the stable base label ("X vs Y"), never a
  // baked-in "(top N of M)" snapshot from whenever the chart was first
  // generated. (That baking was the second bug: the dropdown said "Top 5"
  // but the heading still said "top 20 of 101" because it was never
  // recomputed after the row-limit edit.)
  const displayTitle = showingAll ? group.title : `${group.title} (top ${override.rowLimit} of ${totalRows})`;

  const needsMinWidth = override.kind !== 'donut';
  const minWidth = needsMinWidth ? chartRows.length * MIN_PX_PER_CATEGORY : undefined;

  // Bubble the current effective state up as a plain, JSON-serializable
  // ChartGroup -- exactly the shape the Reports page persists as
  // chart_spec -- whenever an edit changes what's actually being drawn.
  useEffect(() => {
    if (!onChange) return;
    onChange({
      kind: override.kind,
      dimensionIndex: group.dimensionIndex,
      // Always the FULL canonical set, unchanged by kind or by which
      // measures are currently hidden -- see the field's own comment in
      // chart-spec.ts. Only `hiddenMeasureIndices` below records the
      // user's current toggle choice.
      measureIndices: group.measureIndices,
      hiddenMeasureIndices: Array.from(override.hiddenMeasures),
      donutMeasureIndex: override.donutMeasureIndex,
      title: group.title,
      rowIndices: Array.from({ length: Math.min(override.rowLimit, totalRows) }, (_, i) => i),
      truncated: override.rowLimit < totalRows,
    });
    // Deliberately depends on `override` ALONE. `group` and `onChange` are
    // both freshly-created references on every parent render (AutoReportChart
    // passes a new inline arrow function, and a new group object, each time
    // it re-renders) -- including on the very render this effect's own
    // onChange() call triggers. Listing them as deps turns this into an
    // infinite loop: onChange -> parent setState -> re-render -> new
    // group/onChange identity -> effect fires again -> onChange -> ...
    // ("Maximum update depth exceeded"). `override` is real, own-state and
    // only changes on an actual user edit, which is the only time this
    // should re-report.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [override]);

  function toggleMeasure(i: number) {
    setOverride((prev) => {
      const next = new Set(prev.hiddenMeasures);
      if (next.has(i)) {
        next.delete(i);
      } else if (group.measureIndices.filter((m) => !next.has(m)).length > 1) {
        // Never allow hiding the last remaining visible measure -- an
        // empty chart isn't a useful edit result.
        next.add(i);
      }
      return { ...prev, hiddenMeasures: next };
    });
  }

  return (
    <section className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-700">
          {displayTitle}
          {override.kind === 'donut' && group.measureIndices.length > 1 ? (
            <span className="ml-1 font-normal text-slate-400">(showing {table.headers[donutMeasure]} only)</span>
          ) : null}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {/* Chart type switcher */}
          <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {KIND_OPTIONS.map(({ kind, label, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                onClick={() => setOverride((prev) => ({ ...prev, kind }))}
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                  override.kind === kind ? 'bg-white text-blue-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-700'
                }`}
                title={`View as ${label.toLowerCase()} chart`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>

          {/* Donut's dedicated metric selector -- Donut can only ever plot
              ONE measure, so instead of making the user hide every other
              measure with the toggle chips just to pick which one it
              draws, it gets its own direct control. Defaults to the first
              never-negative measure and switches immediately on pick;
              a measure with negative values (e.g. Outstanding, which goes
              negative for a customer credit/overpayment) is listed but
              disabled, since a donut slice can't represent a negative
              share of the whole. */}
          {override.kind === 'donut' && group.measureIndices.length > 1 && (
            <select
              value={override.donutMeasureIndex}
              onChange={(e) => setOverride((prev) => ({ ...prev, donutMeasureIndex: Number(e.target.value) }))}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 outline-none"
              title="Which metric the donut shows"
            >
              {group.measureIndices.map((i) => (
                <option key={i} value={i} disabled={measureHasNegatives(i)}>
                  {table.headers[i]}
                  {measureHasNegatives(i) ? ' (has negative values)' : ''}
                </option>
              ))}
            </select>
          )}

          {/* Row-count control */}
          {rowLimitOptions.length > 1 && (
            <select
              value={override.rowLimit}
              onChange={(e) => setOverride((prev) => ({ ...prev, rowLimit: Number(e.target.value) }))}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 outline-none"
              title="How many rows to chart"
            >
              {rowLimitOptions.map((n) => (
                <option key={n} value={n}>
                  {n >= totalRows ? `All (${totalRows})` : `Top ${n}`}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Measure toggle chips -- for Bar/Line's multiple series. Donut has
          its own dedicated metric selector above instead (a donut only
          ever plots one measure, so "hide" isn't the right control for
          it). */}
      {group.measureIndices.length > 1 && override.kind !== 'donut' && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {group.measureIndices.map((i, mi) => {
            const active = !override.hiddenMeasures.has(i);
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleMeasure(i)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  active ? 'border-slate-200 bg-white text-slate-700' : 'border-slate-100 bg-slate-50 text-slate-400 line-through'
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: active ? SERIES_COLORS[mi % SERIES_COLORS.length] : '#cbd5e1' }}
                />
                {table.headers[i]}
              </button>
            );
          })}
        </div>
      )}

      {override.kind === 'donut' && donutMeasureHasNegatives ? (
        <div className="flex h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-6 text-center">
          <p className="text-sm font-medium text-slate-600">
            A donut can&apos;t show {table.headers[donutMeasure]} here
          </p>
          <p className="max-w-md text-xs text-slate-500">
            Some rows have a negative {table.headers[donutMeasure].toLowerCase()} (e.g. a customer credit/overpayment),
            and a donut slice can&apos;t represent a negative share of the whole. Pick Bar or Line instead, or switch to
            a measure that&apos;s never negative using the chips above.
          </p>
        </div>
      ) : override.kind === 'donut' ? (
        <DonutChart chartRows={chartRows} measureHeader={measureHeaders[0]} />
      ) : (
        <div className={needsMinWidth ? 'overflow-x-auto' : undefined}>
          <div className="h-[320px]" style={minWidth ? { minWidth: `${minWidth}px` } : undefined}>
            <ResponsiveContainer width="100%" height="100%">
              {override.kind === 'line' ? (
                <LineChart data={chartRows} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="__label" {...X_AXIS_PROPS} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} width={56} tickFormatter={formatAxisTick} />
                  <Tooltip />
                  {measureHeaders.map((h, i) => (
                    <Line
                      key={h}
                      type="monotone"
                      dataKey={h}
                      stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                      strokeWidth={2}
                      dot={chartRows.length <= 20}
                    />
                  ))}
                </LineChart>
              ) : (
                <BarChart data={chartRows} margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="__label" {...X_AXIS_PROPS} />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} width={56} tickFormatter={formatAxisTick} />
                  <Tooltip />
                  {measureHeaders.map((h, i) => (
                    <Bar key={h} dataKey={h} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[4, 4, 0, 0]} maxBarSize={40} />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}

// FIX: recharts' default <Legend> tries to lay out every slice name
// inline and wraps onto as many rows as it needs (8+ rows for a 70-slice
// package breakdown), which squeezed the actual donut down to a tiny
// circle in the remaining space. This renders the donut at a fixed,
// generous size on its own, with a separate compact, SCROLLABLE legend
// underneath (2-3 columns, capped height) -- so the chart stays readable
// and full-size no matter how many slices the data has.
function DonutChart({ chartRows, measureHeader }: { chartRows: Record<string, string | number>[]; measureHeader: string }) {
  const total = chartRows.reduce((sum, row) => sum + (typeof row[measureHeader] === 'number' ? (row[measureHeader] as number) : 0), 0);
  const manySlices = chartRows.length > 8;

  return (
    <div>
      <div className="mx-auto h-[340px] w-full max-w-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartRows}
              dataKey={measureHeader}
              nameKey="__label"
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="94%"
              paddingAngle={chartRows.length <= 20 ? 2 : 0.5}
            >
              {chartRows.map((_, i) => (
                <Cell key={i} fill={sliceColor(i, chartRows.length)} stroke="#fff" strokeWidth={1} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value, _name, item) => [
                typeof value === 'number' ? value.toLocaleString('en-US') : String(value),
                String((item?.payload as { __label?: string } | undefined)?.__label ?? ''),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div
        className={`mt-3 grid gap-x-4 gap-y-1.5 overflow-y-auto pr-1 text-xs sm:grid-cols-2 lg:grid-cols-3 ${
          manySlices ? 'max-h-40' : ''
        }`}
      >
        {chartRows.map((row, i) => {
          const value = typeof row[measureHeader] === 'number' ? (row[measureHeader] as number) : 0;
          const pct = total ? Math.round((value / total) * 1000) / 10 : 0;
          return (
            <div key={i} className="flex min-w-0 items-center gap-1.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: sliceColor(i, chartRows.length) }} />
              <span className="min-w-0 flex-1 truncate text-slate-700" title={String(row.__label)}>
                {row.__label}
              </span>
              <span className="shrink-0 font-medium text-slate-500">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AutoReportChart({
  table,
  spec,
  onSpecChange,
}: {
  table: ReportTable;
  spec: ChartSpec;
  // Fires with the FULL updated spec (all groups, not just the one that
  // changed) whenever any single chart's edit changes -- this is exactly
  // the shape the Reports page's chart_spec column stores, so a caller
  // can hand this straight to its own "Save chart" logic with no
  // reshaping. Optional: omit it for a read-only/session-only chart (the
  // chat panel).
  onSpecChange?: (spec: ChartSpec) => void;
}) {
  if (!spec.groups.length) return null;

  function handleGroupChange(index: number, updated: ChartGroup) {
    if (!onSpecChange) return;
    const groups = spec.groups.map((g, i) => (i === index ? updated : g));
    onSpecChange({ groups });
  }

  return (
    <div className="space-y-4">
      {spec.groups.map((group, gi) => (
        <ChartGroupCard
          key={gi}
          table={table}
          group={group}
          onChange={onSpecChange ? (updated) => handleGroupChange(gi, updated) : undefined}
        />
      ))}
    </div>
  );
}
