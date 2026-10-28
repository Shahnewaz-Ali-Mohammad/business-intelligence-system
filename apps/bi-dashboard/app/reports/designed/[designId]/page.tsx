import { ReportDesigner } from '@/components/designer/report-designer';

export default async function DesignedReportPage({ params }: { params: Promise<{ designId: string }> }) {
  const { designId } = await params;
  return <ReportDesigner designId={designId} />;
}
