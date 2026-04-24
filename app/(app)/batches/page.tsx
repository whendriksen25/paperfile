import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Layers } from "lucide-react";

export const dynamic = "force-dynamic";

interface BatchSummary {
  batch: string;
  count: number;
  pending: number;
}

export default async function BatchesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("documents")
    .select("batch, status")
    .not("batch", "is", null)
    .neq("status", "deleted");

  const map = new Map<string, BatchSummary>();
  for (const row of data || []) {
    if (!row.batch) continue;
    const cur = map.get(row.batch) || { batch: row.batch, count: 0, pending: 0 };
    cur.count++;
    if (row.status === "pending" || row.status === "processing")
      cur.pending++;
    map.set(row.batch, cur);
  }
  const batches = Array.from(map.values()).sort((a, b) => b.count - a.count);

  return (
    <div className="max-w-3xl mx-auto px-5 py-6 md:py-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Batches</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Named groups of documents you can review together.
        </p>
      </header>

      {batches.length === 0 ? (
        <div className="surface p-8 text-center text-sm text-muted-foreground">
          No batches yet. When you upload documents, set a batch name like
          "healthcare_dad_2026" to group them.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          {batches.map((b) => (
            <Link
              key={b.batch}
              href={`/inbox?batch=${encodeURIComponent(b.batch)}`}
              className="surface p-4 hover:bg-card/80 transition-colors flex items-center gap-3"
            >
              <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                <Layers className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{b.batch}</div>
                <div className="text-xs text-muted-foreground">
                  {b.count} docs{b.pending > 0 ? ` · ${b.pending} pending` : ""}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
