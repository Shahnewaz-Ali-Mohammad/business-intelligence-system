'use client';

// A getChartSpec() failure is caught with a plain try/catch (it's a pure
// function call) -- but a crash DURING React's render of AutoReportChart
// itself (recharts choking on some data shape, a bad array index, etc.)
// can only be caught by a real error boundary; a try/catch around the
// JSX call site does nothing for render-phase errors. Without this, that
// kind of failure used to mean the chart section just silently never
// appeared, with nothing in the UI or even necessarily the console to
// explain why.
import { Component, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';

export class ChartErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error('[chart] AutoReportChart crashed during render:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="rounded-2xl border border-rose-200 bg-rose-50/80 p-5 shadow-[0_22px_60px_rgb(15_23_42/12%)]">
          <div className="mb-1 flex items-center gap-2">
            <BarChart3 size={18} className="text-rose-500" />
            <p className="font-semibold text-rose-700">Chart failed to render</p>
          </div>
          <p className="text-sm text-rose-600">{this.state.error.message}</p>
          <p className="mt-1 text-xs text-rose-400">The table above is unaffected -- this only stopped the chart. Check the browser console for the full error.</p>
        </section>
      );
    }
    return this.props.children;
  }
}
