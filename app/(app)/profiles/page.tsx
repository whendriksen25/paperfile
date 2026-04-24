"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ProfileForm } from "@/components/profiles/profile-form";
import { useProfiles } from "@/hooks/useProfiles";
import type { ProfileRow } from "@/types/document";
import {
  Trash2,
  Star,
  User,
  Building2,
  ChevronDown,
  ChevronRight,
  Pencil,
  Check,
} from "lucide-react";

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [recentlySavedId, setRecentlySavedId] = useState<number | null>(null);
  const { active: activeProfile } = useProfiles();

  async function load() {
    setLoading(true);
    const res = await fetch("/api/profiles", { cache: "no-store" });
    const json = await res.json();
    setProfiles(json.data || []);
    setLoading(false);
  }

  // Fetch a single fresh profile (used right after save to make sure our local
  // copy reflects exactly what Postgres persisted).
  async function refreshOne(id: number) {
    const res = await fetch(`/api/profiles/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const { data } = await res.json();
    if (data) {
      setProfiles((s) => s.map((p) => (p.id === id ? data : p)));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function setDefault(id: number) {
    await fetch(`/api/profiles/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });
    load();
  }

  async function remove(id: number) {
    if (
      !confirm(
        "Delete this profile? Documents assigned to it will lose the link."
      )
    )
      return;
    const res = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const json = await res.json();
      alert(json.error || "Failed");
      return;
    }
    load();
  }

  const active = activeProfile
    ? profiles.find((p) => p.id === activeProfile.id) || activeProfile
    : null;

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight">Profiles</h1>
        <p className="text-sm text-muted-foreground mt-1">
          File documents under a profile — yourself, family, business. Add a
          description, alternative names, and key attributes so Paperfile
          auto-assigns correctly.
        </p>
      </header>

      {active && <ActiveProfileCard profile={active} />}

      <Card>
        <div className="section-label mb-3">New profile</div>
        <ProfileForm onSaved={() => load()} />
      </Card>

      <Card>
        <div className="section-label mb-3">Your profiles</div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
            <Spinner /> Loading…
          </div>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">
            No profiles yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {profiles.map((p) => {
              const isExpanded = expandedId === p.id;
              const isEditing = editingId === p.id;
              const justSaved = recentlySavedId === p.id;
              return (
                <li key={p.id} className="py-3 first:pt-0 last:pb-0">
                  <ProfileHeaderRow
                    profile={p}
                    expanded={isExpanded}
                    onToggle={() => {
                      setExpandedId(isExpanded ? null : p.id);
                      setEditingId(null);
                    }}
                    onSetDefault={() => setDefault(p.id)}
                    onRemove={() => remove(p.id)}
                  />

                  {isExpanded && (
                    <div className="mt-4 ml-7 pl-3 border-l-2 border-brand-purple/20 space-y-3">
                      {justSaved && (
                        <div className="inline-flex items-center gap-1.5 pill bg-brand-green/10 text-brand-green animate-fade-in">
                          <Check className="h-3 w-3" />
                          Saved
                        </div>
                      )}

                      {isEditing ? (
                        <ProfileForm
                          key={`${p.id}-${p.updated_at}`}
                          profile={p}
                          onSaved={async (updated) => {
                            // Show saved badge, close edit view, refresh row
                            if (updated?.id) {
                              setProfiles((s) =>
                                s.map((x) => (x.id === updated.id ? updated : x))
                              );
                              await refreshOne(updated.id);
                              setRecentlySavedId(updated.id);
                              setTimeout(
                                () => setRecentlySavedId(null),
                                3000
                              );
                            }
                            setEditingId(null);
                          }}
                        />
                      ) : (
                        <ProfileReadOnly
                          profile={p}
                          onEdit={() => setEditingId(p.id)}
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ProfileHeaderRow({
  profile: p,
  expanded,
  onToggle,
  onSetDefault,
  onRemove,
}: {
  profile: ProfileRow;
  expanded: boolean;
  onToggle: () => void;
  onSetDefault: () => void;
  onRemove: () => void;
}) {
  const attrCount = Object.keys(p.attributes || {}).length;
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground"
        title={expanded ? "Collapse" : "Expand"}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>
      <div className="h-10 w-10 rounded-full bg-brand-gradient-soft flex items-center justify-center">
        {p.type === "business" ? (
          <Building2 className="h-4 w-4 text-brand-purple" />
        ) : (
          <User className="h-4 w-4 text-brand-purple" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold truncate">{p.name}</div>
        <div className="text-xs text-muted-foreground truncate">
          {p.description ||
            `${p.type}${
              p.aliases?.length
                ? ` · ${p.aliases.length} alias${
                    p.aliases.length === 1 ? "" : "es"
                  }`
                : ""
            }${
              attrCount > 0
                ? ` · ${attrCount} attribute${attrCount === 1 ? "" : "s"}`
                : ""
            }`}
        </div>
      </div>
      {p.is_default ? (
        <Badge variant="purple">default</Badge>
      ) : (
        <button
          onClick={onSetDefault}
          className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-3 py-1.5 rounded-full hover:bg-muted"
          title="Make default"
        >
          <Star className="h-3.5 w-3.5" />
          Make default
        </button>
      )}
      {!p.is_default && (
        <button
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive p-2 rounded-full hover:bg-muted"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function ProfileReadOnly({
  profile: p,
  onEdit,
}: {
  profile: ProfileRow;
  onEdit: () => void;
}) {
  const attrEntries = Object.entries(p.attributes || {});
  const isEmpty =
    !p.description &&
    !p.aliases?.length &&
    attrEntries.length === 0 &&
    !p.website &&
    !p.ai_summary;

  return (
    <div className="space-y-3 animate-fade-in">
      {isEmpty ? (
        <p className="text-xs text-muted-foreground italic">
          No details yet. Click Edit to add a description, aliases, and
          attributes.
        </p>
      ) : (
        <>
          {p.description && (
            <div>
              <div className="section-label mb-1">Description</div>
              <div className="text-sm">{p.description}</div>
            </div>
          )}
          {p.website && (
            <div>
              <div className="section-label mb-1">Website</div>
              <a
                href={p.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-brand-purple underline"
              >
                {p.website}
              </a>
            </div>
          )}
          {p.ai_summary && (
            <div>
              <div className="section-label mb-1">AI matching summary</div>
              <div className="text-sm text-muted-foreground">
                {p.ai_summary}
              </div>
            </div>
          )}
          {p.aliases?.length > 0 && (
            <div>
              <div className="section-label mb-1">Aliases</div>
              <div className="flex flex-wrap gap-1.5">
                {p.aliases.map((a) => (
                  <Badge key={a}>{a}</Badge>
                ))}
              </div>
            </div>
          )}
          {attrEntries.length > 0 && (
            <div>
              <div className="section-label mb-1">Attributes</div>
              <dl className="text-xs space-y-1">
                {attrEntries.map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3">
                    <dt className="text-muted-foreground font-bold min-w-[120px]">
                      {k}
                    </dt>
                    <dd className="break-all">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
      <button onClick={onEdit} className="btn-secondary text-xs">
        <Pencil className="h-3.5 w-3.5" />
        {isEmpty ? "Add details" : "Edit"}
      </button>
    </div>
  );
}

function ActiveProfileCard({ profile: p }: { profile: ProfileRow }) {
  const attrEntries = Object.entries(p.attributes || {});
  return (
    <Card className="bg-brand-gradient-soft border-brand-purple/30">
      <div className="flex items-center gap-3 mb-3">
        <div className="h-10 w-10 rounded-full bg-white flex items-center justify-center">
          {p.type === "business" ? (
            <Building2 className="h-4 w-4 text-brand-purple" />
          ) : (
            <User className="h-4 w-4 text-brand-purple" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-[0.12em] font-bold text-brand-purple">
            Active profile
          </div>
          <div className="text-base font-extrabold truncate">{p.name}</div>
        </div>
        {p.is_default && <Badge variant="purple">default</Badge>}
      </div>

      {p.description && <p className="text-sm mb-3">{p.description}</p>}

      <div className="flex flex-wrap gap-1.5">
        {(p.aliases || []).map((a) => (
          <Badge key={a}>{a}</Badge>
        ))}
        {attrEntries.map(([k, v]) => (
          <Badge key={k} variant="teal">
            {k}: {String(v).slice(0, 40)}
          </Badge>
        ))}
        {p.website && (
          <a
            href={p.website}
            target="_blank"
            rel="noopener noreferrer"
            className="pill bg-white text-brand-purple border border-brand-purple/20 hover:bg-white/80"
          >
            {p.website.replace(/^https?:\/\//, "")}
          </a>
        )}
      </div>
    </Card>
  );
}
