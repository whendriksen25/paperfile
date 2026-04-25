import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Paperfile",
  description:
    "How Paperfile collects, uses, and protects your data, including Google user data accessed via the Google Tasks integration.",
};

/**
 * Privacy policy. Boilerplate, but written specifically to satisfy:
 *   - Google's OAuth verification "User Data Policy" requirements
 *   - Microsoft's "Publisher attestation" expectations (when we add Outlook)
 *   - Sensible coverage of Supabase auth, Dropbox storage, Anthropic API
 *
 * Wim should review and tweak factual specifics (legal entity, contact
 * email, jurisdiction) before going to verification.
 */
export default function PrivacyPage() {
  return (
    <article className="px-5 md:px-10 py-12 md:py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
        Privacy Policy
      </h1>
      <p className="text-xs text-muted-foreground mt-2">
        Last updated: 25 April 2026
      </p>

      <Section title="Who we are">
        <p>
          Paperfile is a personal document archiver that helps you scan,
          organise, and act on your physical and digital paperwork. This
          policy explains what data we collect, why we collect it, and what
          rights you have.
        </p>
        <p>
          Paperfile is operated by an individual developer based in the
          Netherlands. For questions about your data, contact{" "}
          <a href="mailto:contact@paperfile.nl" className="text-brand-purple">
            contact@paperfile.nl
          </a>
          .
        </p>
      </Section>

      <Section title="What data we store">
        <ul>
          <li>
            <strong>Account info</strong>: email address and a hashed password
            (managed by Supabase Auth).
          </li>
          <li>
            <strong>Documents you upload</strong>: the original files (PDFs,
            images) live in your own Dropbox account at a path you control.
            Paperfile stores their location and the structured metadata
            extracted from them — title, sender, amount, line items, dates,
            tags, OCR text, and similar.
          </li>
          <li>
            <strong>Profiles</strong> you create (e.g. yourself, family
            members, a business): name, optional description, optional
            identifying attributes you fill in (birth date, address, IBAN, etc.).
            Used by Paperfile to match incoming documents to the right person
            or entity.
          </li>
          <li>
            <strong>Actions</strong> derived from your documents (bills to
            pay, contracts to sign, etc.).
          </li>
          <li>
            <strong>Integration tokens</strong>: when you connect Google or
            another third-party service, we store the OAuth refresh token
            so Paperfile can act on your behalf without re-prompting. Tokens
            are stored encrypted at rest by Supabase.
          </li>
        </ul>
      </Section>

      <Section title="Third-party services we use">
        <ul>
          <li>
            <strong>Supabase</strong> (EU region) — authentication, Postgres
            database, row-level security. All your structured data lives here
            in your account-scoped rows; nobody else (including the Paperfile
            developer) can read your rows under normal operation.
          </li>
          <li>
            <strong>Dropbox</strong> — used as the canonical store for the
            original files. We use either your own Dropbox account (if you
            connect it) or a Paperfile-controlled Dropbox folder you have
            access to. The files never live on a Paperfile-owned server beyond
            transient processing.
          </li>
          <li>
            <strong>Anthropic Claude</strong> — used only at the moment a
            document is processed, to read the file and extract structured
            information. The file content is sent to Anthropic for that one
            call and is not retained for training (per Anthropic&apos;s
            commercial terms).
          </li>
          <li>
            <strong>Vercel</strong> — application hosting (no persistent
            storage of your documents).
          </li>
          <li>
            <strong>Google APIs</strong> — only when you explicitly click
            &quot;Connect Google&quot;. See the next section for what that
            scope covers.
          </li>
        </ul>
      </Section>

      <Section title="Google user data we access">
        <p>
          If you connect a Google account via the Settings page, Paperfile
          requests a single OAuth scope:{" "}
          <code>https://www.googleapis.com/auth/tasks</code> (the Google
          Tasks API).
        </p>
        <ul>
          <li>
            <strong>What we read</strong>: we look up your existing task
            lists once to find or create a list called &quot;Paperfile&quot;.
            We do not read the contents of any task you didn&apos;t create
            via Paperfile.
          </li>
          <li>
            <strong>What we write</strong>: each Paperfile action you
            explicitly send to Google becomes one task in the
            &quot;Paperfile&quot; list. When you mark the action done in
            Paperfile, we mark the matching task complete.
          </li>
          <li>
            <strong>What we never do</strong>: we do not access your Gmail,
            Calendar, Drive, Contacts, or any other Google data. We do not
            share your Google data with any third party. We do not use it
            for advertising or analytics. We do not sell it.
          </li>
          <li>
            <strong>Use of Google user data complies with</strong> the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-purple"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </li>
          <li>
            <strong>How to disconnect</strong>: open Settings → Google Tasks →
            Disconnect. This revokes our refresh token at Google and clears
            it from our database. You can also revoke at{" "}
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-purple"
            >
              myaccount.google.com/permissions
            </a>
            .
          </li>
        </ul>
      </Section>

      <Section title="How we use your data">
        <p>
          Your data is used solely to operate the Paperfile service for you:
          to extract structured information from your documents, organise them
          into your profiles and folders, and trigger the actions you ask
          for. We do not sell, rent, or share your data with third parties
          for marketing.
        </p>
      </Section>

      <Section title="Data retention and deletion">
        <p>
          Documents and metadata are kept as long as your account is active.
          You can delete individual documents at any time from the inbox.
          To delete your entire account and associated data, email{" "}
          <a href="mailto:contact@paperfile.nl" className="text-brand-purple">
            contact@paperfile.nl
          </a>
          ; we will remove your data within 30 days. The original files in
          your own Dropbox folder are not deleted by us — those remain under
          your control.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          Under the GDPR (EU residents) and similar laws elsewhere, you have
          the right to access, correct, or delete the personal data we hold,
          and to object to or restrict its processing. Send any request to{" "}
          <a href="mailto:contact@paperfile.nl" className="text-brand-purple">
            contact@paperfile.nl
          </a>
          ; we will respond within 30 days.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Communication with Paperfile is protected by HTTPS. Data at rest is
          encrypted by Supabase and Dropbox using their respective security
          practices. Authentication tokens are stored encrypted; we never log
          plaintext passwords or OAuth tokens.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Paperfile is not directed at children under 16. If you believe a
          child has created an account, please contact us and we will delete
          it.
        </p>
      </Section>

      <Section title="Changes to this policy">
        <p>
          We may update this policy as the service evolves. Material changes
          will be highlighted on the homepage and dated above. Continued use
          of Paperfile after a change constitutes acceptance.
        </p>
      </Section>

      <p className="text-xs text-muted-foreground mt-12">
        See also: <Link href="/terms" className="text-brand-purple">Terms of Service</Link>.
      </p>
    </article>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-extrabold tracking-tight">{title}</h2>
      <div className="mt-3 text-sm leading-relaxed text-foreground/80 space-y-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
        {children}
      </div>
    </section>
  );
}
