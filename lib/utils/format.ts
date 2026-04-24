export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined
): string {
  if (amount == null) return "";
  const cur = currency || "EUR";
  try {
    return new Intl.NumberFormat("nl-BE", {
      style: "currency",
      currency: cur,
    }).format(amount);
  } catch {
    return `${cur} ${amount.toFixed(2)}`;
  }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/_/g, " ")
    .replace(/\w\S*/g, (t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
}
