import Link from "next/link";
import { Wordmark } from "@/components/brand/logo";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-brand-gradient-soft">
      <div className="surface p-8 max-w-sm w-full text-center">
        <div className="flex justify-center mb-4">
          <Wordmark />
        </div>
        <h1 className="text-xl font-extrabold mb-2">Page not found</h1>
        <p className="text-sm text-muted-foreground mb-6">
          That link doesn't go anywhere.
        </p>
        <Link href="/upload" className="btn-primary inline-flex">
          Go to Scan it
        </Link>
      </div>
    </div>
  );
}
