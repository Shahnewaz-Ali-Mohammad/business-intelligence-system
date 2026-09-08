import type { ReactNode } from 'react';
import { WorkspaceSidebar } from './workspace-sidebar';

export function WorkspacePage({
  active,
  title,
  subtitle,
  action,
  children,
}: {
  active: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#e0f2fe_0,#f8fafc_34%,#eef2f7_100%)] text-slate-950">
      <div className="flex h-screen overflow-hidden">
        <WorkspaceSidebar active={active} />
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-20 shrink-0 items-center justify-between gap-4 border-b border-white/70 bg-white/85 px-6 shadow-[0_12px_34px_rgb(15_23_42/8%)] backdrop-blur-xl">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
              <p className="truncate text-sm text-slate-500">{subtitle}</p>
            </div>
            {action}
          </header>
          <div className="min-h-0 flex-1 overflow-hidden px-6 py-6">{children}</div>
        </section>
      </div>
    </main>
  );
}
