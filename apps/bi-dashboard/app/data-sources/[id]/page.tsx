// 2026-10-13: the warehouse-setup page was removed. A workspace is set up
// on its Database & Tool Setup page; old links land there.
import { redirect } from 'next/navigation';

export default async function WorkspaceRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/data-sources/${id}/tools`);
}
