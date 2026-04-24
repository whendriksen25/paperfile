"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export default function RegisterPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.user && !data.session) {
      setInfo("Check your email for the confirmation link.");
      return;
    }
    router.push("/upload");
    router.refresh();
  }

  return (
    <div className="surface p-7 animate-fade-in">
      <header className="mb-6">
        <h1 className="text-xl font-extrabold">Create account</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Scan it. File it. Act on it.
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
        <div className="space-y-1.5">
          <label htmlFor="password" className="section-label">
            Password (min 8 characters)
          </label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {info && <p className="text-sm text-brand-green">{info}</p>}
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? <Spinner /> : "Create account"}
        </Button>
      </form>
      <footer className="mt-6 text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="hover:text-foreground underline">
          Sign in
        </Link>
      </footer>
    </div>
  );
}
