import { Suspense } from 'react';
import { ChatWorkspace } from '@/components/chat/chat-workspace';
import { WorkspacePage } from '@/components/workspace/workspace-page';
import { ChatLanding } from '@/components/chat/chat-landing';

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
// /chat on its own is not a destination: it opens the person's workspace.
// The original (ISP) chat opens only with ?original=1 or one of its saved
// conversations (?session=).
export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (!params.original && !params.session) {
    return (
      <WorkspacePage active="Chat" title="Chat Workspace" subtitle="Ask questions, explore your data, and save reports.">
        <ChatLanding />
      </WorkspacePage>
    );
  }
  return (
    <WorkspacePage
      active="Chat"
      title="Chat Workspace"
      subtitle="Ask questions, explore your data, and save reports."
    >
      <Suspense fallback={null}>
        <ChatWorkspace />
      </Suspense>
    </WorkspacePage>
  );
}
