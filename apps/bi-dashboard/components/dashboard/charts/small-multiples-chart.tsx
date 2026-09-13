'use client';

import { GenericMetricChart } from '@/components/dashboard/charts/generic-metric-chart';

type Entry = { name: string; value: number };
type ExtraMetric = { metric: string; label: string; valuesByName: Record<string, number> };

// When a breakdown has more than one metric per entity (e.g. "customers AND
// revenue by region"), a single chart can't honestly show both: they're on
// completely different scales (dollars in the thousands vs. a small
// customer count), so forcing them onto one shared axis either squashes
// one series flat or requires a dual-axis chart -- and dual-axis charts are
// widely considered bad practice in data viz because two independently
// scaled axes make it trivial to make unrelated series LOOK correlated
// just by how the axes happen to be drawn.
//
// Small multiples is the standard, honest alternative: one small chart per
// metric, same entities in the same order, each on its OWN correct scale.
// You can still compare "is the ranking the same across metrics" at a
// glance (same row order in every panel), without ever misrepresenting the
// actual numbers. Every panel reuses the exact same GenericMetricChart the
// single-metric case uses, so there is only one chart-rendering
// implementation to keep correct.
export function SmallMultiplesChart({
  baseTitle,
  primaryLabel,
  entries,
  extraMetrics,
  chartType,
}: {
  baseTitle: string;
  primaryLabel: string;
  entries: Entry[];
  extraMetrics: ExtraMetric[];
  chartType: 'bar' | 'line' | 'pie' | 'donut' | 'none';
}) {
  // Every panel shows the SAME rows in the SAME order as the primary
  // metric (not re-sorted per metric) -- that's what makes "does Germany
  // rank differently on customers than on revenue" something you can
  // actually see by eye across panels, instead of each panel silently
  // reordering itself.
  const panels = [
    { key: 'primary', label: primaryLabel, entries },
    ...extraMetrics.map((m) => ({
      key: m.metric,
      label: m.label,
      entries: entries.map((row) => ({ name: row.name, value: m.valuesByName[row.name] ?? 0 })),
    })),
  ];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {panels.map((panel) => (
        <GenericMetricChart
          key={panel.key}
          title={panel.label}
          subtitle={`${baseTitle} -- ${panel.label} shown on its own scale`}
          entries={panel.entries}
          chartType={chartType}
        />
      ))}
    </div>
  );
}
