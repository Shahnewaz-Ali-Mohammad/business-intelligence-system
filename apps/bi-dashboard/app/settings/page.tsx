import { WorkspacePage } from '@/components/workspace/workspace-page';

export default function SettingsPage() {
  return (
    <WorkspacePage active="Settings" title="Settings" subtitle="Connection, export, and workspace preferences.">
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
          <h2 className="font-bold">Database Access</h2>
          <p className="mt-2 text-sm text-slate-500">Business data is read from the ecommerce database through the read-only API path.</p>
          <p className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700">
            Read-only mode enabled
          </p>
        </section>
        <section className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-[0_12px_30px_rgb(15_23_42/7%)]">
          <h2 className="font-bold">Report Defaults</h2>
          <p className="mt-2 text-sm text-slate-500">Generated report pages include insights, visualizations, source context, and Excel/CSV actions.</p>
        </section>
      </div>
    </WorkspacePage>
  );
}
