"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Headphones,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useAuth, can } from "@/components/auth/auth-provider";
import { WorkspacePage } from "@/components/workspace/workspace-page";
type Ticket = {
  id: number;
  subject: string;
  status: string;
  ai_summary?: string | null;
  updated_at?: string;
};
type Message = {
  id?: number;
  author_type: string;
  body: string;
  created_at: string;
};
const suggestions = [
  "My internet is slow. What should I try?",
  "My connection keeps dropping. How can I fix it?",
  "The internet is down. What should I check first?",
];
export default function SupportChat() {
  const { user, loading } = useAuth();
  const [active, setActive] = useState<Ticket | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadTicket = useCallback(async (ticket: Ticket, quiet = false) => {
    if (!quiet) setHistoryLoading(true);
    try {
      const response = await fetch(`/api/support/tickets/${ticket.id}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not load this conversation.");
      setActive({ ...ticket, ...data.ticket });
      setMessages(data.messages || []);
      setError("");
    } catch (e) {
      if (!quiet)
        setError(
          e instanceof Error ? e.message : "Could not load this conversation.",
        );
    } finally {
      if (!quiet) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user || !can(user, "chat.use")) return;
    let cancelled = false;
    void (async () => {
      setHistoryLoading(true);
      try {
        const response = await fetch("/api/support/tickets", {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not load your conversations.");
        if (cancelled) return;
        const ownTickets = (data.tickets || []) as Ticket[];
        setTickets(ownTickets);
        if (ownTickets[0]) await loadTicket(ownTickets[0]);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error
              ? e.message
              : "Could not load your conversations.",
          );
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, loadTicket]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void loadTicket(active, true), 4000);
    return () => window.clearInterval(timer);
  }, [active, loadTicket]);

  function startNewConversation() {
    setActive(null);
    setMessages([]);
    setSubject("");
    setText("");
    setError("");
  }
  async function send(message = text) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!active) {
        const r = await fetch("/api/support/tickets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: subject || message.slice(0, 80),
            body: message,
            language: "auto",
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Could not send your message.");
        const ticket = {
          id: d.id,
          subject: subject || message.slice(0, 80),
          status: d.escalated ? "open" : "in_progress",
          ai_summary: d.escalated ? "escalated to human agent" : null,
        };
        setActive(ticket);
        setTickets((current) => [
          ticket,
          ...current.filter((item) => item.id !== ticket.id),
        ]);
        setMessages([
          {
            author_type: "customer",
            body: message,
            created_at: new Date().toISOString(),
          },
          ...(d.ai
            ? [
                {
                  author_type: "ai",
                  body: d.ai.reply,
                  created_at: new Date().toISOString(),
                },
              ]
            : []),
        ]);
      } else {
        const r = await fetch(`/api/support/tickets/${active.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, language: "auto" }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Could not send your message.");
        setMessages((current) => [
          ...current,
          {
            author_type: "customer",
            body: message,
            created_at: new Date().toISOString(),
          },
          ...(d.ai
            ? [
                {
                  author_type: "ai",
                  body: d.ai.reply,
                  created_at: new Date().toISOString(),
                },
              ]
            : []),
        ]);
        if (d.handoff || d.escalated)
          setActive((current) =>
            current
              ? {
                  ...current,
                  status: "open",
                  ai_summary: "escalated to human agent",
                }
              : current,
          );
      }
      setText("");
      setSubject("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  if (loading) return null;
  if (!user || !can(user, "chat.use"))
    return (
      <WorkspacePage
        active="Customer Support"
        title="Customer Support"
        subtitle="Sign in to contact support."
      >
        <p className="rounded-2xl bg-white p-6 text-sm text-zinc-600">
          Support chat access is required.
        </p>
      </WorkspacePage>
    );
  const escalated = active?.ai_summary?.includes("escalated");
  return (
    <WorkspacePage
      active="Customer Support"
      title="Customer Support"
      subtitle="We’re here to help."
      scroll
    >
      <div className="mx-auto flex min-h-[calc(100vh-10rem)] max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-xl shadow-zinc-200/60 ring-1 ring-zinc-200">
        <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-700 text-white">
              <Headphones size={21} />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-900">Support team</h2>
              <p className="flex items-center gap-1 text-xs text-emerald-600">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Usually replies in a few seconds
              </p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs text-zinc-500 sm:flex">
            <ShieldCheck size={16} className="text-emerald-600" />
            Private and secure
          </div>
        </header>
        {tickets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-5 py-3 sm:px-8">
            <label
              htmlFor="support-conversation"
              className="text-xs font-medium text-zinc-500"
            >
              Your conversations
            </label>
            <select
              id="support-conversation"
              value={active?.id ?? "new"}
              onChange={(event) => {
                if (event.target.value === "new") startNewConversation();
                else {
                  const ticket = tickets.find(
                    (item) => item.id === Number(event.target.value),
                  );
                  if (ticket) void loadTicket(ticket);
                }
              }}
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 sm:max-w-md"
            >
              <option value="new">Start a new conversation</option>
              {tickets.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  #{ticket.id} · {ticket.subject}
                </option>
              ))}
            </select>
            {historyLoading && (
              <span className="text-xs text-zinc-400">Loading…</span>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto bg-gradient-to-b from-zinc-50 to-white p-5 sm:p-8">
          {historyLoading && !messages.length ? (
            <div className="flex min-h-[420px] items-center justify-center text-sm text-zinc-500">
              Loading your conversation…
            </div>
          ) : !messages.length ? (
            <div className="mx-auto flex min-h-[420px] max-w-2xl flex-col items-center justify-center text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-rose-50 text-rose-700">
                <Sparkles size={28} />
              </div>
              <h3 className="text-2xl font-semibold text-zinc-900">
                How can we help today?
              </h3>
              <p className="mt-2 max-w-md text-sm leading-6 text-zinc-500">
                Describe an internet connection problem. The AI will suggest
                practical troubleshooting steps, and a support agent can join if
                needed.
              </p>
              <div className="mt-8 grid w-full gap-3 sm:grid-cols-3">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => void send(suggestion)}
                    className="rounded-2xl border border-zinc-200 bg-white p-4 text-left text-sm text-zinc-700 transition hover:-translate-y-0.5 hover:border-rose-300 hover:shadow-md"
                  >
                    {suggestion}
                    <span className="mt-3 block text-xs text-rose-700">
                      Ask support →
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-5">
              {messages.map((message, index) => (
                <div
                  key={message.id ?? `${message.created_at}-${index}`}
                  className={`flex gap-3 ${message.author_type === "customer" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${message.author_type === "customer" ? "order-2 bg-zinc-200 text-zinc-600" : "bg-rose-100 text-rose-700"}`}
                  >
                    {message.author_type === "customer" ? (
                      <UserRound size={17} />
                    ) : (
                      <Sparkles size={17} />
                    )}
                  </div>
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-6 ${message.author_type === "customer" ? "order-1 rounded-br-sm bg-rose-700 text-white" : "rounded-bl-sm bg-white text-zinc-700 shadow-sm ring-1 ring-zinc-200"}`}
                  >
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-60">
                      {message.author_type === "customer"
                        ? "You"
                        : message.author_type === "agent"
                          ? "Support agent"
                          : "AI assistant"}
                    </p>
                    {message.body}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="flex items-center gap-3 text-sm text-zinc-500">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-100 text-rose-700">
                    <Sparkles size={17} />
                  </div>
                  Support is thinking…
                </div>
              )}
              {escalated && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  <b>A support agent has joined this conversation.</b>
                  <br />
                  Your messages are now being handled by a human team member.
                </div>
              )}
            </div>
          )}
        </div>
        {error && (
          <p className="border-t border-red-100 bg-red-50 px-6 py-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <footer className="border-t border-zinc-200 bg-white p-4 sm:p-5">
          <div className="mx-auto max-w-3xl">
            {!active && (
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Topic (optional)"
                className="mb-2 w-full border-0 bg-transparent px-1 text-xs text-zinc-500 outline-none"
              />
            )}
            <div className="flex items-end gap-2 rounded-2xl border border-zinc-300 bg-zinc-50 p-2 focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-100">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder="Write a message…"
                className="min-h-12 flex-1 resize-none border-0 bg-transparent p-2 text-sm outline-none"
              />
              <button
                disabled={busy || !text.trim()}
                onClick={() => void send()}
                className="flex h-11 items-center gap-2 rounded-xl bg-rose-700 px-4 text-sm font-semibold text-white transition hover:bg-rose-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                <Send size={17} />
                <span className="hidden sm:inline">Send</span>
              </button>
            </div>
            <p className="mt-2 text-center text-[11px] text-zinc-400">
              Press Enter to send · Shift + Enter for a new line
            </p>
          </div>
        </footer>
      </div>
    </WorkspacePage>
  );
}
