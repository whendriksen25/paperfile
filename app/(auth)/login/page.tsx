"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/upload");
    router.refresh();
  }

  return (
    <div className="surface p-7 animate-fade-in">
      <header className="mb-6">
        <h1 className="text-xl font-extrabold">Sign in</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Welcome back to your archive.
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
            Password
          </label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? <Spinner /> : "Sign in"}
        </Button>
      </form>
      <footer className="mt-6 flex items-center justify-between text-xs text-muted-foreground">
        <Link href="/reset-password" className="hover:text-foreground">
          Forgot password?
        </Link>
        <Link href="/register" className="hover:text-foreground">
          Create account
        </Link>
      </footer>
    </div>
  );
}
