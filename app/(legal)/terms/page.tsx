import type { Metadata } from "next";
import {
  buildTermsPageJsonLd,
  jsonLdToScriptContent,
} from "@/lib/seo/structured-data";

export const metadata: Metadata = {
  title: "Terms of Service · Noland's Roofing",
  description:
    "Terms governing use of the Noland's Roofing online roofing-estimate platform, including the marketing-text-message and automated-voice-call programs.",
  robots: { index: true, follow: true },
};

const LAST_UPDATED = "May 16, 2026";

export default function TermsPage() {
  // Per-subpage JSON-LD: WebPage + FAQPage + BreadcrumbList mirroring
  // the privacy-page wiring. Same audit fixes apply here.
  const jsonLdNodes = buildTermsPageJsonLd();

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
        <h1>Terms of Service</h1>
        <p className="meta">Last updated · {LAST_UPDATED}</p>
      </header>

      <section>
        <h2>Acceptance</h2>
        <p>
          By using the Noland&apos;s Roofing online roofing-estimate
          platform — including submitting an estimate request at
          estimate.nolandsroofing.com — you agree to these Terms and to
          our <a href="/privacy">Privacy Policy</a>. If you do not agree,
          do not submit a request.
        </p>
      </section>

      <section>
        <h2>What we do</h2>
        <p>
          Noland&apos;s Roofing, Inc. is a Florida-licensed general
          contractor serving Central Florida. This online estimator
          measures a roof from public satellite imagery, identifies
          likely material and condition, and produces a price range.
          After you submit a request, we follow up to provide a binding
          quote and, if you authorize the work, to perform it. Any
          roofing work is performed by Noland&apos;s Roofing under a
          separate written agreement with you.
        </p>
      </section>

      <section>
        <h2>Estimate accuracy</h2>
        <p>
          The price range you see is an estimate based on satellite
          imagery and regional pricing data — not a binding quote. Actual
          prices depend on factors the platform cannot see from above:
          deck condition, code compliance, jobsite accessibility, changes
          in material prices, and so on. A typical estimate falls within
          roughly ten percent of our in-person quote on standard
          residential roofs, but variance can be wider on complex roofs,
          very large properties, or properties where the satellite
          imagery is older. We flag stale-imagery cases when we detect
          them.
        </p>
      </section>

      <section>
        <h2>Marketing-text-message program</h2>
        <p>
          By checking the first consent box on the estimate form, you
          agree to receive an automated text-message intro from
          Noland&apos;s Roofing at the phone number you provided, sent
          via Twilio or a comparable service, plus your estimate by
          email.
        </p>
        <ul>
          <li>
            <strong>Program purpose:</strong> delivering your roofing
            estimate and a brief introduction from Noland&apos;s Roofing.
          </li>
          <li>
            <strong>Frequency:</strong> varies by inquiry, typically
            one to five messages per inquiry.
          </li>
          <li>
            <strong>Carrier charges:</strong> message and data rates may
            apply per your wireless plan. Neither Noland&apos;s Roofing
            nor your carrier is responsible for delayed or undelivered
            messages.
          </li>
          <li>
            <strong>Opt out:</strong> reply <code>STOP</code> to any
            message to cancel. We confirm cancellation and stop messages
            immediately.
          </li>
          <li>
            <strong>Help:</strong> reply <code>HELP</code> or contact{" "}
            <a href="mailto:info@nolandsroofing.com">
              info@nolandsroofing.com
            </a>
            .
          </li>
          <li>
            <strong>Consent is not required:</strong> agreeing to receive
            marketing messages is not a condition of purchasing roofing
            services. You may decline this box and request a callback
            through other channels.
          </li>
        </ul>
      </section>

      <section>
        <h2>Automated-voice-call program</h2>
        <p>
          The second consent box is <strong>optional and separate</strong>.
          By checking it, you authorize an automated voice-intro call
          from Noland&apos;s Roofing at the phone number you provided,
          placed within a few minutes of submission.
        </p>
        <ul>
          <li>
            <strong>Nature of the call:</strong> a short, automated voice
            introduction walking through your estimate. The caller is
            powered by automated technology. You may end the call at any
            time.
          </li>
          <li>
            <strong>Frequency:</strong> typically a single call per
            inquiry. Additional calls may be placed if you re-submit the
            estimator for the same property.
          </li>
          <li>
            <strong>Recording:</strong> calls may be recorded for quality
            and training purposes where permitted by law. We comply with
            two-party-consent jurisdictions by announcing any recording
            at the start of the call.
          </li>
          <li>
            <strong>Opt out:</strong> say &ldquo;remove me,&rdquo; hang
            up, or reply <code>STOP</code> to the SMS thread tied to the
            same phone number. Any of these ends future automated
            contact.
          </li>
          <li>
            <strong>Consent is not required:</strong> you can receive
            your estimate by email and SMS without authorizing this
            call.
          </li>
        </ul>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>
            Submit information about a property you do not own or have
            authority to obtain an estimate for.
          </li>
          <li>
            Submit fake, scraped, or automated requests, or attempt to
            overwhelm the platform with traffic.
          </li>
          <li>
            Use any imagery, estimate, or other output for any purpose
            other than evaluating roofing services for the property you
            requested.
          </li>
          <li>
            Reverse-engineer, scrape, or otherwise extract data from the
            platform&apos;s pages or APIs.
          </li>
        </ul>
      </section>

      <section>
        <h2>Intellectual property</h2>
        <p>
          The platform — including the page design, the underlying code,
          and any model output — is the property of Noland&apos;s
          Roofing, Inc. or its licensors and protected by applicable
          copyright and trademark law. Satellite imagery is provided by
          third parties (Google Maps Platform and others) under their
          own terms.
        </p>
      </section>

      <section>
        <h2>Disclaimers</h2>
        <p className="disclaimer">
          The platform is provided &ldquo;as is&rdquo; and &ldquo;as
          available.&rdquo; Noland&apos;s Roofing disclaims all
          warranties, express or implied, including merchantability,
          fitness for a particular purpose, and non-infringement.
          Estimates are not binding offers and do not constitute
          professional advice. Roofing work is governed by your direct
          written agreement with Noland&apos;s Roofing.
        </p>
      </section>

      <section>
        <h2>Limitation of liability</h2>
        <p className="disclaimer">
          To the maximum extent permitted by law, Noland&apos;s
          Roofing&apos;s liability for any claim arising out of or
          related to your use of the platform is limited to the greater
          of $100 or the amounts Noland&apos;s Roofing has received from
          you for use of the platform in the prior twelve months
          (typically zero, because the estimator is free to homeowners —
          fees for roofing work are governed by your separate written
          agreement). Noland&apos;s Roofing is not liable for any
          indirect, incidental, special, consequential, or punitive
          damages, including loss of profits, business, or data.
        </p>
      </section>

      <section>
        <h2>Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws of the State of Florida
          without regard to its conflict-of-laws principles. Any dispute
          will be resolved by binding arbitration in Lake County,
          Florida, under the American Arbitration Association&apos;s
          Consumer Arbitration Rules — except that either party may
          bring a claim in small-claims court for eligible matters. You
          may opt out of arbitration within thirty days of first using
          the platform by emailing{" "}
          <a href="mailto:info@nolandsroofing.com">
            info@nolandsroofing.com
          </a>
          .
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>
          We may update these Terms over time. Material changes will be
          reflected in the &ldquo;Last updated&rdquo; date and, where
          required, communicated to users with an active inquiry.
          Continued use of the platform after a change constitutes
          acceptance of the revised Terms.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Noland&apos;s Roofing, Inc.
          <br />
          1295 W. Hwy. 50, Clermont, FL 34711
          <br />
          Phone: (352) 242-4322
          <br />
          Email:{" "}
          <a href="mailto:info@nolandsroofing.com">
            info@nolandsroofing.com
          </a>
        </p>
      </section>
    </div>
  );
}
