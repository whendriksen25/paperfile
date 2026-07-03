"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export default function ResetPasswordPage() {
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    // Use the ACTUAL origin the user is on (production, Vercel preview, or
    // localhost) — NEXT_PUBLIC_APP_URL is baked in at build time and was
    // sending reset links to localhost:3002 from deployed environments.
    // The origin must also be allowlisted in Supabase Auth → URL Configuration.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setInfo("If that email exists, a reset link was sent.");
  }

  return (
    <div className="surface p-7 animate-fade-in">
      <header className="mb-6">
        <h1 className="text-xl font-extrabold">Reset password</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enter your email — we'll send a reset link.
        </p>
      </header>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="email" className="section-label">
            Email
          </label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {info && <p className="text-sm text-brand-green">{info}</p>}
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? <Spinner /> : "Send reset link"}
        </Button>
      </form>
      <footer className="mt-6 text-xs text-muted-foreground">
        <Link href="/login" className="hover:text-foreground underline">
          Back to sign in
        </Link>
      </footer>
    </div>
  );
}
