"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle2 } from "lucide-react";

/**
 * Lets the user paste the URL of their bookkeeping app (e.g. http://localhost:3001
 * for local dev, https://bookkeeping.example.com for prod) plus an optional
 * shared secret. Saved server-side so the push API can read it.
 */
export function BookkeepingSettings() {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => {
        const s = j?.data || {};
        setUrl(s.bookkeeping_url || "");
        setToken(s.bookkeeping_token || "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookkeeping_url: url,
          bookkeeping_token: token,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setSavedAt(Date.now());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1.5">
        <label className="section-label">Bookkeeping app URL</label>
        <input
          type="url"
          placeholder="http://localhost:3001  or  https://bookkeeping.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={!loaded}
          className="input"
        />
        <p className="text-xs text-muted-foreground">
          The base URL of your bookkeeping app. Paperfile will POST documents
          to <code>{url || "<url>"}/api/external/paperfile-import</code>.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="section-label">Shared secret (optional)</label>
        <input
          type="text"
          placeholder="Same value as PAPERFILE_PUSH_TOKEN on the bookkeeping side"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={!loaded}
          className="input font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Sent as <code>x-paperfile-token</code> header. Recommended in
          production so only Paperfile can push.
        </p>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          disabled={saving || !loaded}
          className="btn-primary text-xs !py-2"
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : "Save"}
        </button>
        {savedAt && Date.now() - savedAt < 4000 && (
          <span className="text-xs text-brand-green font-semibold flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved
          </span>
        )}
        {error && (
          <span className="text-xs text-destructive font-semibold">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
