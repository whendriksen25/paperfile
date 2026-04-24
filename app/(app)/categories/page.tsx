import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { titleCase } from "@/lib/utils/format";
import { ListTree } from "lucide-react";

export const dynamic = "force-dynamic";

interface CategorySummary {
  type: string;
  count: number;
}

export default async function CategoriesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("documents")
    .select("document_type, purchase_category, status")
    .neq("status", "deleted");

  const typeMap = new Map<string, number>();
  const purchaseMap = new Map<string, number>();

  for (const row of data || []) {
    if (row.document_type) {
      typeMap.set(
        row.document_type,
        (typeMap.get(row.document_type) || 0) + 1
      );
    }
    if (row.purchase_category) {
      purchaseMap.set(
        row.purchase_category,
        (purchaseMap.get(row.purchase_category) || 0) + 1
      );
    }
  }

  const types: CategorySummary[] = Array.from(typeMap.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const purchases: CategorySummary[] = Array.from(purchaseMap.entries())
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-4xl mx-auto space-y-5">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight">Categories</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse your library grouped by what kind of document and what kind of
          purchase.
        </p>
      </header>

      <Card>
        <div className="section-label mb-4">Document types</div>
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No documents yet.
          </p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {types.map((c) => (
              <Link
                key={c.type}
                href={`/inbox?type=${encodeURIComponent(c.type)}`}
                className="flex items-center gap-3 rounded-2xl px-4 py-3 hover:bg-muted transition-colors"
              >
                <div className="h-9 w-9 rounded-full bg-brand-purple/10 flex items-center justify-center">
                  <ListTree className="h-4 w-4 text-brand-purple" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold truncate">
                    {titleCase(c.type)}
                  </div>
                </div>
                <span className="text-xs font-bold text-muted-foreground">
                  {c.count}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="section-label mb-4">Purchase categories</div>
        {purchases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Categories appear here once Paperfile classifies receipts and bills.
          </p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {purchases.map((c) => (
              <div
                key={c.type}
                className="flex items-center gap-3 rounded-2xl px-4 py-3 bg-brand-gradient-soft"
              >
                <div className="text-sm font-bold flex-1">
                  {titleCase(c.type)}
                </div>
                <span className="text-xs font-bold text-muted-foreground">
                  {c.count}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
