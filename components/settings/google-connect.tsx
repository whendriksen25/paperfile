"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

/**
 * Connect / disconnect block for Google Tasks integration. Reads the user's
 * current connection state from /api/settings, shows a "Connect" button
 * if not connected (links to /api/oauth/google/start), or the connected
 * email + a Disconnect button if connected.
 *
 * Watches the URL for ?google_connected=1 / ?google_error=xxx so the
 * status updates immediately after returning from Google.
 */
export function GoogleConnect() {
  const [email, setEmail] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(
    null
  );

  async function load() {
    setLoading(true);
    const res = await fetch("/api/settings");
    const json = await res.json().catch(() => ({}));
    const g = json?.data?.google_oauth;
    setConnected(!!g?.refresh_token);
    setEmail(g?.email || null);
    setLoading(false);
  }

  useEffect(() => {
    load();
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get("google_connected") === "1") {
        setFlash({ kind: "ok", msg: "Google account connected." });
      }
      const err = sp.get("google_error");
      if (err) setFlash({ kind: "err", msg: decodeURIComponent(err) });
      // Clear the URL params so a refresh doesn't re-show the flash.
      if (sp.get("google_connected") || sp.get("google_error")) {
        const url = new URL(window.location.href);
        url.searchParams.delete("google_connected");
        url.searchParams.delete("google_error");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, []);

  async function disconnect() {
    if (!confirm("Disconnect your Google account from Paperfile?")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/oauth/google/disconnect", {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Disconnect failed");
      }
      setFlash({ kind: "ok", msg: "Google account disconnected." });
      await load();
    } catch (e: unknown) {
      setFlash({
        kind: "err",
        msg: e instanceof Error ? e.message : "Disconnect failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking…
        </div>
      ) : connected ? (
        <>
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-brand-green/10 border border-brand-green/30 px-4 py-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-brand-green" />
              <div>
                <div className="font-bold text-sm">Connected</div>
                {email && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {email}
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={disconnect}
              disabled={busy}
              className="btn-secondary text-xs !py-2"
            >
              Disconnect
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            New actions in your Action Center will show a &quot;Send to Google
            Tasks&quot; button. They&apos;ll appear in a list called
            &quot;Paperfile&quot; in your Google Tasks.
          </p>
        </>
      ) : (
        <>
          <a
            href="/api/oauth/google/start"
            className="btn-primary text-sm inline-flex"
          >
            Connect Google
          </a>
          <p className="text-xs text-muted-foreground">
            Asks for the &quot;tasks&quot; scope only — Paperfile can create and
            close tasks but cannot read your other Google data.
          </p>
        </>
      )}
      {flash && (
        <div
          className={`flex items-start gap-2 text-xs font-semibold ${
            flash.kind === "ok" ? "text-brand-green" : "text-destructive"
          }`}
        >
          {flash.kind === "ok" ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          )}
          <span>{flash.msg}</span>
        </div>
      )}
    </div>
  );
}
