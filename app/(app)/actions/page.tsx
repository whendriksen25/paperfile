"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  X,
  AlertCircle,
  Search,
  Sliders,
  Calendar,
  Trello,
  Download,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ProfileSelector } from "@/components/layout/profile-selector";
import { formatDate, titleCase } from "@/lib/utils/format";
import type { ActionRow } from "@/types/document";

interface ActionWithDoc extends ActionRow {
  document: {
    id: string;
    title: string | null;
    sender: string | null;
    document_type: string | null;
    file_name: string | null;
    dropbox_path: string | null;
  } | null;
}

export default function ActionsPage() {
  const [items, setItems] = useState<ActionWithDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"open" | "done" | "dismissed" | "all">(
    "open"
  );
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/actions?status=${filter}`);
    const json = await res.json();
    setItems(json.data || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function update(id: string, patch: Record<string, unknown>) {
    setItems((s) =>
      s.map((it) =>
        it.id === id
          ? {
              ...it,
              ...patch,
              status: (patch.status as ActionRow["status"]) || it.status,
            }
          : it
      )
    );
    await fetch(`/api/actions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (filter !== "all" && patch.status && patch.status !== filter) load();
  }

  function isOverdue(d: string | null): boolean {
    if (!d) return false;
    return new Date(d) < new Date(new Date().toDateString());
  }

  const filtered = items.filter((a) =>
    !query
      ? true
      : a.summary.toLowerCase().includes(query.toLowerCase()) ||
        a.document?.title?.toLowerCase().includes(query.toLowerCase())
  );

  const highPriority = filtered.filter(
    (a) => a.status === "open" && isOverdue(a.due_date)
  );
  const upcoming = filtered.filter(
    (a) => a.status === "open" && !isOverdue(a.due_date)
  );
  const closed = filtered.filter((a) => a.status !== "open");

  const pendingCount = items.filter((a) => a.status === "open").length;
  const focused =
    filtered.find((a) => a.id === focusedId) ||
    filtered.find((a) => a.status === "open") ||
    filtered[0];

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4">
        <header>
          <h1 className="text-3xl font-extrabold tracking-tight">
            Action Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tasks Paperfile derived from your documents. Schedule them, finish
            them, or push to Trello.
          </p>
        </header>
        <div className="flex items-center gap-3">
          <ProfileSelector />
          <span className="pill bg-brand-purple/10 text-brand-purple">
            <span className="h-5 w-5 rounded-full bg-brand-purple text-white text-[10px] font-bold flex items-center justify-center">
              {pendingCount}
            </span>
            Pending Actions
          </span>
        </div>
      </div>

      {/* Bulk export bar */}
      <div className="surface px-4 py-3 mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-bold">Plan these actions</span>
          <span className="text-muted-foreground">
            {" "}
            — subscribe in your calendar or push to a Trello board.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/actions/export?format=ics&status=open"
            className="btn-secondary text-xs"
          >
            <Calendar className="h-3.5 w-3.5" /> Calendar (.ics)
          </a>
          <a
            href="/api/actions/export?format=trello&status=open"
            className="btn-secondary text-xs"
          >
            <Trello className="h-3.5 w-3.5" /> Trello CSV
          </a>
        </div>
      </div>

      <div className="grid lg:grid-cols-[360px_1fr] gap-5">
        {/* Left column: list */}
        <div className="surface p-4 space-y-4 self-start">
          <div className="relative">
            <Search className="h-4 w-4 text-muted-foreground absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              placeholder="Search tasks…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="input-pill pl-11 pr-11"
            />
            <Sliders className="h-4 w-4 text-muted-foreground absolute right-4 top-1/2 -translate-y-1/2" />
          </div>

          <div className="flex gap-2">
            {(["open", "done", "dismissed", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[11px] uppercase tracking-wider font-bold px-3 py-1.5 rounded-full transition-colors ${
                  filter === f
                    ? "bg-brand-charcoal text-white"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Spinner /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-8">
              {filter === "open"
                ? "Nothing pending."
                : `No ${filter} actions.`}
            </div>
          ) : (
            <>
              {highPriority.length > 0 && (
                <Section label="High priority">
                  {highPriority.map((a) => (
                    <ActionRowItem
                      key={a.id}
                      action={a}
                      overdue
                      active={a.id === focused?.id}
                      onClick={() => setFocusedId(a.id)}
                    />
                  ))}
                </Section>
              )}
              {upcoming.length > 0 && (
                <Section label="Upcoming">
                  {upcoming.map((a) => (
                    <ActionRowItem
                      key={a.id}
                      action={a}
                      active={a.id === focused?.id}
                      onClick={() => setFocusedId(a.id)}
                    />
                  ))}
                </Section>
              )}
              {closed.length > 0 && (
                <Section label="Closed">
                  {closed.map((a) => (
                    <ActionRowItem
                      key={a.id}
                      action={a}
                      active={a.id === focused?.id}
                      onClick={() => setFocusedId(a.id)}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        {/* Right column: focused action */}
        {focused ? (
          <FocusedAction
            action={focused as ActionWithDoc}
            onMarkDone={() => update(focused.id, { status: "done" })}
            onDismiss={() => update(focused.id, { status: "dismissed" })}
            onReopen={() => update(focused.id, { status: "open" })}
          />
        ) : (
          <div className="surface p-10 text-center text-sm text-muted-foreground">
            Pick an action on the left to see details.
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="section-label text-brand-purple">{label}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function ActionRowItem({
  action,
  overdue,
  active,
  onClick,
}: {
  action: ActionWithDoc;
  overdue?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-2xl px-3 py-3 transition-colors ${
        active ? "bg-brand-gradient-soft" : "hover:bg-muted"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-bold leading-snug">{action.summary}</div>
        {action.due_date && (
          <span
            className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full whitespace-nowrap ${
              overdue
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {formatDate(action.due_date)}
          </span>
        )}
      </div>
      {action.document && (
        <div className="text-xs text-muted-foreground mt-1 truncate">
          {action.document.title || action.document.file_name}
        </div>
      )}
    </button>
  );
}

function FocusedAction({
  action,
  onMarkDone,
  onDismiss,
  onReopen,
}: {
  action: ActionWithDoc;
  onMarkDone: () => void;
  onDismiss: () => void;
  onReopen: () => void;
}) {
  const isPay = action.action_type === "pay";

  return (
    <div className="space-y-5">
      {/* Tag row */}
      <div className="surface p-5 flex items-center gap-3 flex-wrap">
        {action.document?.document_type && (
          <Badge variant="purple">
            {titleCase(action.document.document_type)}
          </Badge>
        )}
        <Badge variant="green">{titleCase(action.action_type)}</Badge>
        <div className="flex-1" />
        {action.document && (
          <Link
            href={`/document/${action.document.id}`}
            className="text-xs text-muted-foreground hover:text-foreground truncate"
          >
            View source →
          </Link>
        )}
      </div>

      {/* Hero */}
      <div className="surface p-8 text-center">
        <h2 className="text-2xl font-extrabold mb-2">
          {isPay ? "Ready to pay?" : action.summary}
        </h2>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          {isPay
            ? "Open the source document to find the payee details, then mark this action done."
            : action.summary}
        </p>
      </div>

      {/* CTA + planning */}
      <div className="surface p-6 space-y-4">
        <button
          onClick={onMarkDone}
          className="btn-cta w-full"
        >
          {isPay ? "Pay online now" : "Mark as done"}
        </button>

        <div className="flex flex-wrap items-center justify-center gap-2">
          <button onClick={onMarkDone} className="btn-secondary text-xs">
            <CheckCircle2 className="h-3.5 w-3.5" /> Mark Done
          </button>
          <button onClick={onDismiss} className="btn-secondary text-xs">
            <X className="h-3.5 w-3.5" /> Dismiss
          </button>
          {action.status !== "open" && (
            <button onClick={onReopen} className="btn-ghost text-xs">
              <AlertCircle className="h-3.5 w-3.5" /> Reopen
            </button>
          )}
        </div>

        {/* Planning: calendar / trello */}
        <div className="border-t border-border pt-4">
          <div className="section-label mb-2">Plan it</div>
          <div className="flex flex-wrap gap-2">
            {action.due_date ? (
              <a
                href={`/api/actions/${action.id}/calendar`}
                className="btn-secondary text-xs"
              >
                <Calendar className="h-3.5 w-3.5" /> Add to calendar (.ics)
              </a>
            ) : (
              <span className="text-xs text-muted-foreground italic">
                No due date — add one to schedule it.
              </span>
            )}
            <a
              href="/api/actions/export?format=trello&status=open"
              className="btn-secondary text-xs"
            >
              <Trello className="h-3.5 w-3.5" /> Export to Trello
            </a>
          </div>
        </div>
      </div>

      {/* Source preview */}
      {action.document && (
        <div className="surface p-5">
          <div className="section-label mb-2">Source File</div>
          <Link
            href={`/document/${action.document.id}`}
            className="block group"
          >
            <div className="rounded-2xl bg-muted/40 aspect-[4/3] flex items-center justify-center text-muted-foreground text-xs mb-3">
              Document preview
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-brand-purple">
              Filename
            </div>
            <div className="text-sm font-bold truncate group-hover:underline">
              {action.document.title || action.document.file_name}
            </div>
          </Link>
        </div>
      )}

      {/* Hidden import-balancers (icons referenced for compile completeness) */}
      <Download className="hidden" />
    </div>
  );
}
