'use client';

import { useState } from 'react';
import { ArrowUpRight, MoreHorizontal } from 'lucide-react';
import type { Kpi, TopCustomerByOrders } from '@/lib/dashboard/types';

export function KpiCard({
  kpi,
  topCustomers,
}: {
  kpi: Kpi;
  topCustomers?: TopCustomerByOrders[];
}) {
  const isCustomerMixCard = kpi.label === 'Active Customers';
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const chartWidth = 280;
  const chartHeight = 118;
  const plot = { left: 34, right: 12, top: 14, bottom: 28 };
  const plotWidth = chartWidth - plot.left - plot.right;
  const plotHeight = chartHeight - plot.top - plot.bottom;
  const sourcePoints =
    kpi.chartPoints?.length > 0
      ? kpi.chartPoints
      : kpi.sparkline.map((value, index) => ({
          label: `${kpi.axis.xStart} - ${kpi.axis.xEnd}`,
          value: kpi.value,
          normalized: value,
        }));
  const chartPoints = sourcePoints.map((point, index) => {
    const x =
      plot.left +
      (sourcePoints.length <= 1
        ? plotWidth / 2
        : (index / (sourcePoints.length - 1)) * plotWidth);
    const y = plot.top + (1 - point.normalized / 100) * plotHeight;

    return { ...point, x, y };
  });
  const points = chartPoints.map((point) => `${point.x},${point.y}`).join(' ');
  const activePoint =
    activePointIndex === null ? null : chartPoints[activePointIndex] ?? null;
  const tooltipLeft = activePoint ? `${(activePoint.x / chartWidth) * 100}%` : '50%';
  const tooltipTop = activePoint
    ? `${Math.max(4, ((activePoint.y - 56) / chartHeight) * 100)}%`
    : '0%';

  return (
    <section className="flex min-h-[390px] flex-col rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)] ring-1 ring-white transition hover:-translate-y-0.5 hover:shadow-[0_18px_40px_rgb(15_23_42/10%)]">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-600">{kpi.label}</p>
          <p className="mt-2 text-4xl font-bold tracking-tight text-slate-950">
            {kpi.value}
          </p>
        </div>
        <MoreHorizontal size={18} className="text-slate-400" />
      </div>
      <p
        className={`mb-2 flex items-center gap-1 text-sm ${
          kpi.trend === 'up' ? 'text-emerald-600' : 'text-red-600'
        }`}
      >
        <ArrowUpRight size={15} className={kpi.trend === 'down' ? 'rotate-90' : ''} />
        {kpi.delta}
      </p>
      <p className="text-sm font-medium text-slate-700">{kpi.detail}</p>
      <p className="mt-1 text-xs text-slate-500">{kpi.context}</p>
      {isCustomerMixCard ? (
        <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-3">
          {topCustomers && topCustomers.length > 0 ? (
            <>
              <p className="mb-2 text-xs font-medium text-slate-500">
                Top {topCustomers.length} customers by orders placed
              </p>
              <ul className="space-y-1.5">
                {(() => {
                  const max = Math.max(...topCustomers.map((c) => c.orders), 1);
                  return topCustomers.map((customer, index) => (
                    <li key={`${customer.name}-${index}`} className="flex items-center gap-2 text-xs">
                      <span className="w-4 shrink-0 text-slate-400">{index + 1}</span>
                      <span className="w-24 shrink-0 truncate text-slate-700" title={customer.name}>
                        {customer.name}
                      </span>
                      <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.max((customer.orders / max) * 100, 6)}%`,
                            backgroundColor: kpi.accent,
                          }}
                        />
                      </span>
                      <span className="w-6 shrink-0 text-right font-medium text-slate-600">
                        {customer.orders}
                      </span>
                    </li>
                  ));
                })()}
              </ul>
            </>
          ) : (
            <p className="text-xs text-slate-400">
              No verified customer-linking column on this schema — showing the
              active-customer count only.
            </p>
          )}
          <div className="mt-3 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm">
            <span className="font-medium text-slate-700">Source: </span>
            <span>{kpi.source}</span>
          </div>
        </div>
      ) : (
      <div
        className="relative mt-4 overflow-hidden rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2"
        onMouseLeave={() => setActivePointIndex(null)}
      >
        {activePoint ? (
          <div
            className="pointer-events-none absolute z-10 min-w-[132px] -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-xl shadow-slate-950/10"
            style={{
              left: tooltipLeft,
              top: tooltipTop,
            }}
          >
            <p className="font-semibold text-slate-950">{activePoint.label}</p>
            <p className="mt-1 font-medium" style={{ color: kpi.accent }}>
              {activePoint.value}
            </p>
          </div>
        ) : null}
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="h-[150px] w-full"
          role="img"
          aria-label={`${kpi.label} mini chart with hover values`}
        >
          <line
            x1={plot.left}
            y1={plot.top}
            x2={plot.left}
            y2={plot.top + plotHeight}
            stroke="#cbd5e1"
            strokeWidth="1.5"
          />
          <line
            x1={plot.left}
            y1={plot.top + plotHeight}
            x2={plot.left + plotWidth}
            y2={plot.top + plotHeight}
            stroke="#cbd5e1"
            strokeWidth="1.5"
          />
          {[0.25, 0.5, 0.75].map((tick) => (
            <line
              key={tick}
              x1={plot.left}
              y1={plot.top + plotHeight * tick}
              x2={plot.left + plotWidth}
              y2={plot.top + plotHeight * tick}
              stroke="#e2e8f0"
              strokeWidth="1"
            />
          ))}
          <text x="0" y={plot.top + 4} className="fill-slate-500 text-[10px]">
            {kpi.axis.yMax}
          </text>
          <text x="0" y={plot.top + plotHeight} className="fill-slate-500 text-[10px]">
            {kpi.axis.yMin}
          </text>
          <polyline
            points={points}
            fill="none"
            stroke={kpi.accent}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3.5"
          />
          {activePoint ? (
            <>
              <line
                x1={activePoint.x}
                y1={plot.top}
                x2={activePoint.x}
                y2={plot.top + plotHeight}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                strokeWidth="1.5"
              />
            </>
          ) : null}
          {chartPoints.map((point, index) => (
            <circle
              key={`hit-${point.label}-${point.value}`}
              cx={point.x}
              cy={point.y}
              r="10"
              fill="transparent"
              className="cursor-pointer"
              onMouseEnter={() => setActivePointIndex(index)}
              onFocus={() => setActivePointIndex(index)}
            />
          ))}
          {activePoint ? (
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r="6.5"
              fill="white"
              stroke={kpi.accent}
              strokeWidth="3"
            />
          ) : null}
          <text
            x={plot.left}
            y={chartHeight - 5}
            className="fill-slate-500 text-[10px]"
          >
            {kpi.axis.xStart}
          </text>
          <text
            x={plot.left + plotWidth}
            y={chartHeight - 5}
            textAnchor="end"
            className="fill-slate-500 text-[10px]"
          >
            {kpi.axis.xEnd}
          </text>
        </svg>
        <div className="mt-2 rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs text-slate-500 shadow-sm">
          <span className="font-medium text-slate-700">Source: </span>
          <span>{kpi.source}</span>
        </div>
      </div>

      )}
      <p className="mt-auto border-t border-slate-100 pt-3 text-xs text-slate-500">
        {kpi.footer}
      </p>
    </section>
  );
}
