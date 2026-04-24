import { Spinner } from "@/components/ui/spinner";

export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm gap-2">
      <Spinner /> Loading…
    </div>
  );
}
