import { Suspense } from 'react';
import { ChatWorkspace } from '@/components/chat/chat-workspace';
import { WorkspacePage } from '@/components/workspace/workspace-page';

// FIX 2026-09-17: this used to `await getHomeDashboardData()` right here,
// which round-trips to the readonly-api backend (7+ real Postgres queries
// -- see dashboard-data.mjs) and BLOCKED THE ENTIRE PAGE NAVIGATION until
// it finished, on every single visit to /chat -- including "Continue this
// conversation" from Sessions, which routes to this exact same page. That
// data is only ever used for cosmetic page_state context sent along with a
// chat message (see chat-workspace.tsx's activeData usage) -- nothing the
// user sees on first paint needs it. It's now fetched client-side, after
// the chat UI itself has already rendered, so opening Chat (or continuing
// a saved conversation) is instant instead of waiting on a warehouse query
// round trip first.
export default function ChatPage() {
  return (
    <WorkspacePage
      active="Chat"
      title="Chat Workspace"
      subtitle="Ask questions, generate charts, and turn answers into saved reports."
      scroll
    >
      <Suspense fallback={null}>
        <ChatWorkspace />
      </Suspense>
    </WorkspacePage>
  );
}
