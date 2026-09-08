import { Suspense } from 'react';
import { ChatWorkspace } from '@/components/chat/chat-workspace';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { getHomeDashboardData } from '@/lib/dashboard/metrics';

export default async function ChatPage() {
  const data = await getHomeDashboardData();

  return (
    <WorkspacePage
      active="Chat"
      title="Chat Workspace"
      subtitle="Ask questions, generate charts, and turn answers into saved reports."
    >
      <Suspense fallback={null}>
        <ChatWorkspace initialData={data} />
      </Suspense>
    </WorkspacePage>
  );
}
