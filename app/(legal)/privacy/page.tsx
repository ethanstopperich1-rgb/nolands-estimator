import type { Metadata } from "next";
import {
  buildPrivacyPageJsonLd,
  jsonLdToScriptContent,
} from "@/lib/seo/structured-data";

export const metadata: Metadata = {
  title: "Privacy Policy · Voxaris",
  description:
    "How Voxaris collects, uses, and protects information from homeowners and partner contractors who use the Voxaris roofing-estimate platform.",
  robots: { index: true, follow: true },
};

// Bump this whenever the policy text materially changes. TCPA / SMS
// rules require the version in effect at the time of consent to be
// retrievable, so the date is part of the audit trail.
const LAST_UPDATED = "May 16, 2026";

export default function PrivacyPage() {
  // Per-subpage JSON-LD: WebPage (author = Voxaris Organization,
  // mentions = hard product stats) + FAQPage (6 privacy-specific Q&As
  // mirroring the policy text) + BreadcrumbList (Home → Privacy).
  // Closes the audit findings on author info, statistics, FAQPage,
  // and question-phrased headings being only on the homepage.
  const jsonLdNodes = buildPrivacyPageJsonLd();

  return (
    <div className="space-y-1">
      {jsonLdNodes.map((node, i) => (
        <script
          key={i}
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger -- typed builder, no user input
          dangerouslySetInnerHTML={{ __html: jsonLdToScriptContent(node) }}
        />
      ))}
      <header>
        <h1>Privacy Policy</h1>
        <p className="meta">Last updated · {LAST_UPDATED}</p>
      </header>

      <section>
        <h2>Who we are</h2>
        <p>
          Voxaris, Inc. (&ldquo;Voxaris,&rdquo; &ldquo;we,&rdquo;
          &ldquo;us&rdquo;) operates the Voxaris roofing-estimate platform
          at pitch.voxaris.io and on partner-contractor subdomains. This
          policy describes what information we collect, how we use it, who
          we share it with, and the choices you have.
        </p>
      </section>

      <section>
        <h2>Information we collect</h2>
        <p>When you request a roofing estimate, we collect:</p>
        <ul>
          <li>Your name, phone number, and email address.</li>
          <li>The property address you want estimated.</li>
          <li>
            The exact location of the pin you confirmed on a satellite map
            of that address.
          </li>
          <li>
            Your consents — both the consent to receive your estimate by
            email and a text-message intro, and, if you opted in, the
            separate consent authorizing an automated voice-intro call.
            Each consent is stored with its disclosure text, your IP
            address, your user-agent, and a timestamp.
          </li>
          <li>
            Standard web telemetry (browser, device type, referring page,
            timestamps) used to operate the site, prevent abuse, and
            improve performance.
          </li>
        </ul>
        <p>
          We also access public satellite imagery and government storm
          records for the property address you provide. We do not collect
          imagery of the inside of your home, and we do not access any
          data on your device beyond what your browser sends with each
          request.
        </p>
      </section>

      <section>
        <h2>How we use information</h2>
        <ul>
          <li>
            Generate your roofing estimate — measure the roof from
            satellite imagery, identify visible roof features and likely
            condition, and produce a price range.
          </li>
          <li>
            Deliver the estimate to you and to the partner contractor
            associated with the site you visited.
          </li>
          <li>
            Send you the communications you consented to — the estimate
            itself, a brief text-message intro from the contractor, and,
            only if you separately opted in, an automated voice-intro
            call.
          </li>
          <li>
            Operate and improve the platform, including measuring how
            closely an estimate matches the contractor&apos;s in-person
            quote.
          </li>
          <li>
            Detect and prevent fraud, abuse, and unauthorized access —
            including automated bot-traffic filtering at the form-submit
            step.
          </li>
        </ul>
      </section>

      <section>
        <h2>Who we share with</h2>
        <p>
          The partner contractor associated with the site you visited —
          and only that contractor — receives your estimate request and
          contact information. We do not sell or rent your data to
          third-party marketing lists. We use a limited set of service
          providers strictly to operate the platform:
        </p>
        <ul>
          <li>
            Cloud hosting and database (Vercel, Supabase) — where the
            application runs and where your record is stored.
          </li>
          <li>
            Communications providers (Twilio for SMS; the partner
            contractor&apos;s voice infrastructure for the optional
            outbound voice call) — only when you have granted the
            corresponding consent.
          </li>
          <li>
            Mapping and imagery (Google Maps Platform) — to resolve your
            address and retrieve satellite imagery of the property.
          </li>
          <li>
            Error monitoring (Sentry) — to diagnose failures and improve
            reliability. Personally identifying information is scrubbed
            from error reports.
          </li>
        </ul>
        <p>
          We may disclose information when legally required (court order,
          subpoena, regulatory request) or when needed to investigate
          fraud or protect the safety of users.
        </p>
      </section>

      <section>
        <h2>Marketing-text-message program</h2>
        <p>
          By checking the first consent box on the estimate form, you
          agree to receive an automated text-message intro from your
          assigned partner contractor at the phone number you provided,
          sent via Twilio, plus your estimate by email.
        </p>
        <ul>
          <li>
            <strong>Program purpose:</strong> delivering your roofing
            estimate and a brief introduction from the contractor.
          </li>
          <li>
            <strong>Frequency:</strong> varies by inquiry, typically
            one to five messages.
          </li>
          <li>
            <strong>Carrier charges:</strong> message and data rates may
            apply per your wireless plan.
          </li>
          <li>
            <strong>Opt out:</strong> reply <code>STOP</code> to any text
            to cancel. The opt-out is honored immediately and is
            permanent unless you re-enroll.
          </li>
          <li>
            <strong>Help:</strong> reply <code>HELP</code> or email{" "}
            <a href="mailto:support@voxaris.io">support@voxaris.io</a>.
          </li>
          <li>
            <strong>Consent is not required:</strong> agreeing to receive
            messages is not a condition of purchasing roofing services.
          </li>
        </ul>
      </section>

      <section>
        <h2>Automated-voice-call program</h2>
        <p>
          The second consent box is <strong>optional and separate</strong>.
          By checking it, you authorize an automated voice-intro call from
          your assigned partner contractor at the phone number you
          provided, placed within a few minutes of submission.
        </p>
        <ul>
          <li>
            <strong>What it is:</strong> a short, automated voice
            introduction that walks you through your estimate. You may
            hang up at any time.
          </li>
          <li>
            <strong>Frequency:</strong> typically a single call. If you
            re-enter the estimator for the same property, additional
            calls may be placed.
          </li>
          <li>
            <strong>Recording:</strong> calls may be recorded for quality
            and training purposes where permitted by law. State laws
            vary; we comply with two-party-consent jurisdictions by
            announcing recording at the start of any recorded call.
          </li>
          <li>
            <strong>Opt out:</strong> say &ldquo;remove me,&rdquo; hang
            up, or reply <code>STOP</code> to the SMS thread for the same
            phone number — any of those ends future automated contact.
          </li>
          <li>
            <strong>Consent is not required:</strong> you may receive
            your estimate without authorizing the voice call.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your choices</h2>
        <ul>
          <li>
            <strong>Opt out of SMS:</strong> reply STOP to any text. The
            opt-out is permanent unless you re-enroll.
          </li>
          <li>
            <strong>Opt out of voice calls:</strong> reply STOP to the
            associated SMS thread, hang up, or say &ldquo;remove me&rdquo;
            during the call.
          </li>
          <li>
            <strong>Opt out of email:</strong> use the unsubscribe link
            in any marketing email, or contact support.
          </li>
          <li>
            <strong>Access, correct, delete:</strong> email{" "}
            <a href="mailto:privacy@voxaris.io">privacy@voxaris.io</a>{" "}
            from the address on file with a copy, correction, or
            deletion request. We respond within thirty days.
          </li>
          <li>
            <strong>California, Colorado, Virginia, and other state-law
            residents:</strong>{" "}
            you have specific rights under CCPA / CPA / VCDPA and
            equivalent statutes, including the right to know what data
            we hold, to delete it, and to opt out of any &ldquo;sale&rdquo;
            or &ldquo;sharing&rdquo; of personal information. We do not
            sell personal information.
          </li>
        </ul>
      </section>

      <section>
        <h2>Data retention</h2>
        <p>
          We retain your inquiry and consent record for as long as the
          partner contractor is actively engaged with your estimate, plus
          seven years for legal-compliance and dispute-resolution purposes
          (TCPA cases have long statutes of limitation). After that,
          records are deleted or anonymized.
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          Records are encrypted in transit (TLS) and at rest. Access is
          restricted to operations staff and the assigned contractor. We
          do not store payment-card data — billing for partner contractors
          is handled by a PCI-compliant payment processor.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          The platform is intended for property owners eighteen or older.
          We do not knowingly collect information from anyone under
          eighteen. If you believe a minor has submitted information,
          contact us and we will delete the record.
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>
          We may revise this policy as the platform evolves. Material
          changes will be reflected in the &ldquo;Last updated&rdquo;
          date at the top and, where required, communicated to active
          users via email.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Privacy questions:{" "}
          <a href="mailto:privacy@voxaris.io">privacy@voxaris.io</a>
          <br />
          General support:{" "}
          <a href="mailto:support@voxaris.io">support@voxaris.io</a>
        </p>
      </section>
    </div>
  );
}
