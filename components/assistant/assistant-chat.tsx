"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sparkles, X, Send, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Paperfile Assistant — global floating chat.
 *
 * Talks to POST /api/assistant. Three response types:
 *  - answer:           plain text (markdown links rendered as <Link>)
 *  - navigate:         router.push(url) + a short confirmation line
 *  - action_proposal:  a card with Confirm / Cancel; Confirm calls
 *                      POST /api/assistant/execute
 */

interface Proposal {
  tool: string;
  input: Record<string, unknown>;
  summary: string;
}

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "proposal";
      proposal: Proposal;
      state: "pending" | "running" | "done" | "cancelled" | "error";
      result?: string;
    };

/** Render assistant text with [label](/path) markdown links as app links. */
function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\((\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <Link
        key={key++}
        href={m[2]}
        className="text-brand-purple font-semibold underline underline-offset-2 hover:opacity-80"
      >
        {m[1]}
      </Link>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <span className="whitespace-pre-wrap">{parts}</span>;
}

export function AssistantChat() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, open]);

  function historyFor(list: Entry[]): { role: "user" | "assistant"; text: string }[] {
    return list
      .filter((e): e is Extract<Entry, { kind: "user" | "assistant" }> =>
        e.kind === "user" || e.kind === "assistant"
      )
      .slice(-10)
      .map((e) => ({ role: e.kind, text: e.text }));
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const base: Entry[] = [...entries, { kind: "user", text: message }];
    setEntries(base);

    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: historyFor(entries) }),
      });
      const json = await res.json();

      if (!res.ok) {
        setEntries([
          ...base,
          { kind: "assistant", text: json.error || "Something went wrong — try again." },
        ]);
      } else if (json.type === "navigate" && json.url) {
        setEntries([...base, { kind: "assistant", text: json.reply || "Opening it for you." }]);
        router.push(json.url);
      } else if (json.type === "action_proposal" && json.proposal) {
        const next: Entry[] = [...base];
        if (json.reply) next.push({ kind: "assistant", text: json.reply });
        next.push({ kind: "proposal", proposal: json.proposal, state: "pending" });
        setEntries(next);
      } else {
        setEntries([...base, { kind: "assistant", text: json.reply || "…" }]);
      }
    } catch {
      setEntries([
        ...base,
        { kind: "assistant", text: "Couldn't reach the assistant — check your connection." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(idx: number) {
    const entry = entries[idx];
    if (entry.kind !== "proposal" || entry.state !== "pending") return;
    const update = (patch: Partial<Extract<Entry, { kind: "proposal" }>>) =>
      setEntries((cur) =>
        cur.map((e, i) => (i === idx && e.kind === "proposal" ? { ...e, ...patch } : e))
      );
    update({ state: "running" });
    try {
      const res = await fetch("/api/assistant/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: entry.proposal.tool, input: entry.proposal.input }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        update({ state: "error", result: json.error || "Failed." });
      } else {
        update({ state: "done", result: json.summary || "Done." });
        router.refresh();
      }
    } catch {
      update({ state: "error", result: "Network error." });
    }
  }

  function cancel(idx: number) {
    setEntries((cur) =>
      cur.map((e, i) =>
        i === idx && e.kind === "proposal" && e.state === "pending"
          ? { ...e, state: "cancelled" }
          : e
      )
    );
  }

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-3 rounded-full bg-zinc-900 text-white text-sm font-semibold shadow-lg hover:shadow-xl hover:scale-[1.03] transition-all"
          aria-label="Open assistant"
        >
          <Sparkles className="h-4 w-4 text-brand-teal" />
          Assistant
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="fixed bottom-5 right-5 z-50 w-[380px] max-w-[calc(100vw-2.5rem)] flex flex-col rounded-2xl bg-white border border-border shadow-2xl overflow-hidden animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-zinc-900 text-white">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-brand-teal" />
              Paperfile Assistant
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-full hover:bg-white/10"
              aria-label="Close assistant"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 max-h-[420px] min-h-[200px]">
            {entries.length === 0 && (
              <div className="text-xs text-muted-foreground px-1 py-2 space-y-2">
                <p className="font-semibold text-foreground text-sm">
                  Ask me anything about your archive.
                </p>
                <p>“Where is my insurance policy from 2024?”</p>
                <p>“Which CJIB fines are still open?”</p>
                <p>“Re-file that hotel invoice under Power on Wheels.”</p>
              </div>
            )}

            {entries.map((e, i) => {
              if (e.kind === "user") {
                return (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-900 text-white text-sm px-3 py-2">
                      {e.text}
                    </div>
                  </div>
                );
              }
              if (e.kind === "assistant") {
                return (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-muted text-sm px-3 py-2">
                      <RichText text={e.text} />
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={i}
                  className="rounded-xl border border-border bg-white shadow-soft px-3 py-2.5 text-sm"
                >
                  <div className="section-label mb-1">Proposed action</div>
                  <div className="font-medium">{e.proposal.summary}</div>
                  {e.state === "pending" && (
                    <div className="flex gap-2 mt-2.5">
                      <button
                        onClick={() => confirm(i)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900 text-white text-xs font-semibold hover:opacity-90"
                      >
                        <Check className="h-3 w-3" /> Confirm
                      </button>
                      <button
                        onClick={() => cancel(i)}
                        className="px-3 py-1.5 rounded-full border border-border text-xs font-semibold hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {e.state === "running" && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
                    </div>
                  )}
                  {e.state === "done" && (
                    <div className="mt-2 text-xs font-semibold text-brand-teal">
                      ✓ {e.result}
                    </div>
                  )}
                  {e.state === "cancelled" && (
                    <div className="mt-2 text-xs text-muted-foreground">Cancelled.</div>
                  )}
                  {e.state === "error" && (
                    <div className="mt-2 text-xs font-semibold text-red-600">{e.result}</div>
                  )}
                </div>
              );
            })}

            {busy && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>

          <div className="border-t border-border p-2.5 flex items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask, find, or instruct…"
              className="flex-1 text-sm px-3 py-2 rounded-full border border-border bg-white focus:outline-none focus:ring-2 focus:ring-brand-purple/30"
              disabled={busy}
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              className={cn(
                "p-2.5 rounded-full bg-zinc-900 text-white transition-opacity",
                (busy || !input.trim()) && "opacity-40"
              )}
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
