import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { BookkeepingSettings } from "@/components/settings/bookkeeping-settings";
import { GoogleConnect } from "@/components/settings/google-connect";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const dropboxConfigured = Boolean(process.env.DROPBOX_ACCESS_TOKEN);
  const anthropicConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  const devLoginActive = process.env.DEV_AUTO_LOGIN === "true";
  const storageProvider = process.env.DEFAULT_STORAGE_PROVIDER || "dropbox";

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-2xl mx-auto space-y-5">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight">Settings</h1>
      </header>

      <Card>
        <div className="section-label mb-2">Account</div>
        <div className="text-sm font-semibold">{user?.email}</div>
        {devLoginActive && (
          <p className="text-xs text-brand-purple mt-2">
            Dev auto-login is on. Set DEV_AUTO_LOGIN=false in .env.local to
            require manual sign-in.
          </p>
        )}
      </Card>

      <Card>
        <div className="section-label mb-3">Integrations</div>
        <div className="space-y-3 text-sm">
          <Row
            name="Storage"
            value={`${storageProvider} ${dropboxConfigured ? "· connected" : "· not configured"}`}
            active={dropboxConfigured}
          />
          <Row
            name="Anthropic Claude"
            value={anthropicConfigured ? "Connected (Sonnet)" : "Not configured"}
            active={anthropicConfigured}
          />
        </div>
      </Card>

      <Card>
        <div className="section-label mb-3">Google Tasks</div>
        <p className="text-xs text-muted-foreground mb-4">
          Push individual Paperfile actions into a &quot;Paperfile&quot; list in
          your Google Tasks. Marking an action done in Paperfile will also
          close the Google Task. Per-action button — you decide which actions
          matter enough to remember outside Paperfile.
        </p>
        <GoogleConnect />
      </Card>

      <Card>
        <div className="section-label mb-3">Bookkeeping handoff</div>
        <p className="text-xs text-muted-foreground mb-4">
          When Paperfile recognises a doc as an invoice, receipt, bill, or
          bank/credit-card statement, an action appears in your Action Center
          to send it to your bookkeeping app. Statements are forwarded as
          structured transactions (no re-parsing on the other side). Paste the
          URL below and the &quot;Send&quot; button on those actions will start
          working.
        </p>
        <BookkeepingSettings />
      </Card>
    </div>
  );
}

function Row({
  name,
  value,
  active,
}: {
  name: string;
  value: string;
  active: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border last:border-0 pb-3 last:pb-0">
      <div>
        <div className="font-bold">{name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{value}</div>
      </div>
      <span
        className={`pill ${
          active
            ? "bg-brand-green/10 text-brand-green"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {active ? "connected" : "not set"}
      </span>
    </div>
  );
}
