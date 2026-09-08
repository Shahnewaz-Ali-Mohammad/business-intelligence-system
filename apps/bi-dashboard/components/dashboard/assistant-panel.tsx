import type { FormEvent } from 'react';
import { MessageSquareText, Send, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DashboardData } from '@/lib/dashboard/metrics';
import { StatusBadge } from './status-badge';
import type { ChatMessage } from './types';

const SUGGESTED_PROMPTS = [
  'Show revenue by region',
  'Explain average order value',
  'Compare paid and pending orders',
  'Which products drive revenue?',
];

export function AssistantPanel({
  chatInput,
  chatMessages,
  data,
  frozen,
  loading,
  onInputChange,
  onSubmit,
  onUsePrompt,
}: {
  chatInput: string;
  chatMessages: ChatMessage[];
  data: DashboardData;
  frozen: boolean;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsePrompt: (prompt: string) => void;
}) {
  return (
    <aside className="hidden h-screen w-[340px] shrink-0 overflow-hidden border-l border-slate-200/80 bg-white/95 shadow-[-8px_0_30px_rgb(15_23_42/4%)] xl:flex xl:flex-col">
      <div className="shrink-0 border-b border-slate-200/80 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 shadow-sm">
            <MessageSquareText size={18} />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-950">Chat with Data</h2>
            <p className="text-xs text-slate-500">Answers, sources, and generated analysis.</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {chatMessages.length === 0 ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm leading-6 text-slate-700 shadow-sm">
              Ask a question about the live ecommerce data, or request a new analysis page. Numbers are pulled from the read-only database path.
            </div>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Try asking</p>
              <div className="space-y-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onUsePrompt(prompt)}
                    className="flex w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-left text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                  >
                    <SlidersHorizontal size={15} className="shrink-0 text-blue-600" />
                    <span>{prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {chatMessages.map((message, index) => (
              <div
                key={`${message.role}-${index}-${message.text}`}
                className={`rounded-xl border px-3 py-2.5 text-sm shadow-sm ${
                  message.role === 'user'
                    ? 'ml-8 border-blue-100 bg-blue-50 text-blue-950'
                    : 'mr-8 border-slate-200 bg-slate-50/90 text-slate-700'
                }`}
              >
                <p className="mb-1 text-[11px] font-semibold uppercase text-slate-400">
                  {message.role === 'user' ? 'You' : 'Assistant'}
                </p>
                <p className="leading-5">{message.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="shrink-0 border-t border-slate-200/80 bg-white/95 p-4">
        <div className="rounded-xl border border-blue-200 bg-white p-2 shadow-[0_10px_25px_rgb(37_99_235/10%)]">
          <textarea
            value={chatInput}
            onChange={(event) => onInputChange(event.target.value)}
            className="min-h-20 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400"
            placeholder={frozen ? 'Unfreeze this page before asking.' : data.promptSuggestion}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <StatusBadge status={frozen ? 'Freeze' : 'Live'} />
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-2 rounded-lg bg-blue-600 px-4 font-semibold shadow-sm shadow-blue-600/20 hover:bg-blue-700"
              disabled={loading || frozen || !chatInput.trim()}
            >
              <Send size={15} />
              {loading ? 'Working' : 'Ask'}
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
