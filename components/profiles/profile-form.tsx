"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Plus, X, Sparkles, Globe } from "lucide-react";
import type { ProfileRow } from "@/types/document";

interface ProfileFormProps {
  profile?: ProfileRow;
  onSaved?: (p: ProfileRow) => void;
}

export function ProfileForm({ profile, onSaved }: ProfileFormProps) {
  const editing = Boolean(profile);
  const [name, setName] = useState(profile?.name || "");
  const [type, setType] = useState<"person" | "business">(
    profile?.type || "person"
  );
  const [website, setWebsite] = useState(profile?.website || "");
  const [description, setDescription] = useState(profile?.description || "");
  const [aiSummary, setAiSummary] = useState(profile?.ai_summary || "");
  const [aliasesText, setAliasesText] = useState(
    (profile?.aliases || []).join(", ")
  );
  const [attrs, setAttrs] = useState<Array<{ key: string; value: string }>>(
    () => {
      const a = profile?.attributes || {};
      return Object.entries(a).map(([key, value]) => ({
        key,
        value: String(value),
      }));
    }
  );
  const [saving, setSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrichInfo, setEnrichInfo] = useState<string | null>(null);

  // Re-seed the form whenever the parent passes a different or updated profile
  // (e.g. after save → load() refetches and hands us the fresh row).
  useEffect(() => {
    if (!profile) return;
    setName(profile.name || "");
    setType(profile.type || "person");
    setWebsite(profile.website || "");
    setDescription(profile.description || "");
    setAiSummary(profile.ai_summary || "");
    setAliasesText((profile.aliases || []).join(", "));
    setAttrs(
      Object.entries(profile.attributes || {}).map(([key, value]) => ({
        key,
        value: String(value),
      }))
    );
    setError(null);
    setEnrichInfo(null);
    // Depend on id + updated_at so prop-swap or server-updated rows both trigger
    // a re-sync. Ignoring the full-object reference prevents spurious re-seeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id, profile?.updated_at]);

  function addAttr() {
    setAttrs((s) => [...s, { key: "", value: "" }]);
  }
  function removeAttr(i: number) {
    setAttrs((s) => s.filter((_, idx) => idx !== i));
  }
  function updateAttr(i: number, key: string, value: string) {
    setAttrs((s) =>
      s.map((row, idx) => (idx === i ? { key, value } : row))
    );
  }

  async function enrichFromWebsite() {
    if (!website.trim()) {
      setError("Enter a website URL first.");
      return;
    }
    setEnriching(true);
    setError(null);
    setEnrichInfo(null);
    try {
      const res = await fetch("/api/profiles/enrich", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: website.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Enrichment failed");

      const e = json.data || {};
      // Pre-fill blank fields, don't clobber what the user already wrote
      if (e.name && !name.trim()) setName(e.name);
      if (e.description && !description.trim()) setDescription(e.description);
      if (e.ai_summary) setAiSummary(e.ai_summary);
      if (Array.isArray(e.aliases) && e.aliases.length) {
        const merged = Array.from(
          new Set(
            [
              ...aliasesText.split(",").map((s) => s.trim()).filter(Boolean),
              ...e.aliases,
            ]
          )
        );
        setAliasesText(merged.join(", "));
      }
      if (e.attributes && typeof e.attributes === "object") {
        const incoming = Object.entries(e.attributes as Record<string, string>);
        setAttrs((current) => {
          const map = new Map(current.map((a) => [a.key.trim().toLowerCase(), a]));
          for (const [k, v] of incoming) {
            const lk = k.trim().toLowerCase();
            if (!map.has(lk) || !map.get(lk)?.value) {
              map.set(lk, { key: k, value: String(v) });
            }
          }
          return Array.from(map.values()).filter((a) => a.key);
        });
      }
      setEnrichInfo("Auto-filled from website. Review and edit before saving.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Enrichment failed");
    } finally {
      setEnriching(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const aliases = aliasesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const attributes: Record<string, string> = {};
    for (const a of attrs) {
      if (a.key.trim()) attributes[a.key.trim()] = a.value.trim();
    }

    const url = editing ? `/api/profiles/${profile!.id}` : "/api/profiles";
    const method = editing ? "PATCH" : "POST";

    // Build minimal body. On PATCH, only send fields the user actually touched
    // so PostgREST never sees a column it might not yet have cached (common
    // during the window between applying a migration and the schema cache
    // refreshing).
    const body: Record<string, unknown> = {
      name: name.trim(),
      type,
      aliases,
      attributes,
    };
    const prev = profile;
    const include = (key: string, cur: string, prior: string | null | undefined) => {
      // Always include on create; on edit include only if changed from server value
      if (!editing) return cur.trim().length > 0;
      return cur.trim() !== (prior || "").trim();
    };
    if (include("description", description, prev?.description))
      body.description = description.trim() || null;
    if (include("website", website, prev?.website))
      body.website = website.trim() || null;
    if (include("ai_summary", aiSummary, prev?.ai_summary))
      body.ai_summary = aiSummary.trim() || null;

    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(json.error || "Failed to save");
      return;
    }
    if (json.droppedColumns?.length) {
      setError(
        `Saved partially. Columns missing from the DB schema cache: ${json.droppedColumns.join(", ")}. Run "NOTIFY pgrst, 'reload schema';" in Supabase SQL Editor to fix.`
      );
    }
    if (onSaved && json.data) onSaved(json.data);
    if (!editing) {
      setName("");
      setWebsite("");
      setDescription("");
      setAiSummary("");
      setAliasesText("");
      setAttrs([]);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Input
          placeholder='Name e.g. "Father", "Wife", "MyBV"'
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "person" | "business")}
          className="input w-36"
        >
          <option value="person">Person</option>
          <option value="business">Business</option>
        </select>
      </div>

      {type === "business" && (
        <div>
          <label className="section-label block mb-1.5">Website</label>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="relative">
              <Globe className="h-4 w-4 text-muted-foreground absolute left-4 top-1/2 -translate-y-1/2" />
              <Input
                placeholder="https://www.example.com"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="pl-11"
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={enrichFromWebsite}
              disabled={enriching || !website.trim()}
            >
              {enriching ? (
                <Spinner />
              ) : (
                <>
                  <Sparkles className="h-4 w-4" /> Auto-fill
                </>
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Paperfile fetches the page, asks Claude to extract company name,
            description, address, VAT, industry, and pre-fills the fields below.
            You can edit before saving.
          </p>
        </div>
      )}

      <div>
        <label className="section-label block mb-1.5">Description</label>
        <Textarea
          placeholder='e.g. "My father, born 1955, lives in Antwerp, retired engineer."'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      {aiSummary && (
        <div>
          <label className="section-label block mb-1.5">
            AI matching summary
          </label>
          <Textarea
            value={aiSummary}
            onChange={(e) => setAiSummary(e.target.value)}
            rows={3}
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Used by the AI when matching new documents to this profile.
          </p>
        </div>
      )}

      <div>
        <label className="section-label block mb-1.5">Aliases</label>
        <Input
          placeholder="Other names, comma-separated"
          value={aliasesText}
          onChange={(e) => setAliasesText(e.target.value)}
        />
      </div>

      <div>
        <label className="section-label block mb-2">Attributes</label>
        <div className="space-y-2">
          {attrs.map((a, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <Input
                placeholder="key (e.g. iban, vat_number)"
                value={a.key}
                onChange={(e) => updateAttr(i, e.target.value, a.value)}
              />
              <Input
                placeholder="value"
                value={a.value}
                onChange={(e) => updateAttr(i, a.key, e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeAttr(i)}
                className="p-2 text-muted-foreground hover:text-destructive rounded-full"
                title="Remove"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addAttr}
            className="btn-ghost text-xs"
          >
            <Plus className="h-3.5 w-3.5" /> Add attribute
          </button>
        </div>
      </div>

      {enrichInfo && <p className="text-xs text-brand-purple">{enrichInfo}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" disabled={saving || !name.trim()}>
        {saving ? (
          <Spinner />
        ) : editing ? (
          "Save changes"
        ) : (
          <>
            <Plus className="h-4 w-4" /> Add profile
          </>
        )}
      </Button>
    </form>
  );
}
