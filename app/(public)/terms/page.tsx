import Link from "next/link";

export const metadata = {
  title: "Terms of Service — Paperfile",
  description:
    "The terms under which Paperfile is offered. Personal use, no warranties for early-access service, fair acceptable use.",
};

/**
 * Terms of service. Personal-use-friendly boilerplate. Wim should review
 * the legal entity, jurisdiction, and contact specifics before relying on
 * this for verification or for paying customers.
 */
export default function TermsPage() {
  return (
    <article className="px-5 md:px-10 py-12 md:py-16 max-w-3xl mx-auto">
      <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight">
        Terms of Service
      </h1>
      <p className="text-xs text-muted-foreground mt-2">
        Last updated: 25 April 2026
      </p>

      <Section title="1. About these terms">
        <p>
          These Terms of Service (&quot;Terms&quot;) govern your use of
          Paperfile (the &quot;Service&quot;). By creating an account or
          using the Service you agree to these Terms. If you do not agree,
          do not use the Service.
        </p>
      </Section>

      <Section title="2. The service">
        <p>
          Paperfile is a personal document archiver: it lets you upload
          scanned documents, automatically extracts structured information
          using third-party AI, files originals in your own cloud storage,
          and produces a list of derived actions. The Service is currently
          offered in early access, free of charge, on an as-is basis.
        </p>
      </Section>

      <Section title="3. Your account">
        <p>
          You must provide an accurate email and keep your password secure.
          You are responsible for activity that occurs under your account.
          You may not share your account with others; create a separate
          account for each person.
        </p>
      </Section>

      <Section title="4. Acceptable use">
        <p>You agree not to use the Service to:</p>
        <ul>
          <li>upload content that is illegal, infringing, or that you do not have the right to upload;</li>
          <li>attempt to access another user&apos;s data without authorisation;</li>
          <li>reverse-engineer, scrape, or interfere with the Service&apos;s operation;</li>
          <li>upload malware, or content that is intended to harm or defraud third parties;</li>
          <li>circumvent rate limits or other technical safeguards.</li>
        </ul>
      </Section>

      <Section title="5. Your data and content">
        <p>
          You retain ownership of all documents and metadata you upload.
          By uploading, you grant Paperfile a limited licence to process
          and store that data for the sole purpose of operating the Service
          for you, including transmitting documents to the third-party AI
          provider for extraction (see the Privacy Policy for details).
        </p>
        <p>
          You may export or delete your data at any time. See the{" "}
          <Link href="/privacy" className="text-brand-purple">
            Privacy Policy
          </Link>{" "}
          for retention and deletion details.
        </p>
      </Section>

      <Section title="6. Third-party services">
        <p>
          Paperfile integrates with third-party services (Dropbox, Google,
          Anthropic, Supabase, etc.). Your use of those services is
          additionally governed by their own terms. Paperfile is not
          responsible for the availability or content of third-party
          services.
        </p>
      </Section>

      <Section title="7. No warranty">
        <p>
          The Service is provided &quot;as is&quot; without warranties of
          any kind, express or implied, including merchantability, fitness
          for a particular purpose, or non-infringement. AI extraction may
          contain errors — always verify critical information against the
          original document before acting on it.
        </p>
      </Section>

      <Section title="8. Limitation of liability">
        <p>
          To the maximum extent permitted by law, Paperfile and its operators
          will not be liable for any indirect, incidental, special, or
          consequential damages, including loss of profits or data, arising
          out of your use of the Service. Direct liability, where it cannot
          be excluded, is limited to the fees you have paid us in the prior
          twelve months (which, for the free early-access service, is zero).
        </p>
      </Section>

      <Section title="9. Termination">
        <p>
          You may stop using the Service and delete your account at any time
          (see the Privacy Policy for the deletion request). We may suspend
          or terminate your account if you breach these Terms or if we are
          required to do so by law.
        </p>
      </Section>

      <Section title="10. Changes">
        <p>
          We may update these Terms as the Service evolves. Material changes
          will be highlighted on the homepage and dated above. Continued use
          of the Service after a change constitutes acceptance of the new
          Terms.
        </p>
      </Section>

      <Section title="11. Governing law">
        <p>
          These Terms are governed by the laws of the Netherlands, without
          regard to conflict-of-law rules. Disputes will be submitted to
          the competent courts of Amsterdam, except where mandatory consumer
          law gives you a different right.
        </p>
      </Section>

      <Section title="12. Contact">
        <p>
          Questions about these Terms? Email{" "}
          <a href="mailto:contact@paperfile.nl" className="text-brand-purple">
            contact@paperfile.nl
          </a>
          .
        </p>
      </Section>

      <p className="text-xs text-muted-foreground mt-12">
        See also:{" "}
        <Link href="/privacy" className="text-brand-purple">
          Privacy Policy
        </Link>
        .
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
