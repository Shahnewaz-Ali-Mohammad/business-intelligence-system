import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { getHomeDashboardData } from '@/lib/dashboard/metrics';

export default async function Home() {
  const data = await getHomeDashboardData();

  return <DashboardShell data={data} />;
}
