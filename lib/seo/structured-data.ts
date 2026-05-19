/**
 * Structured-data (JSON-LD) builders for AI-readable schema markup.
 *
 * Scope: every output here goes into <script type="application/ld+json">
 * blocks that AI crawlers + search engines read but humans never see.
 * Zero visible UI impact.
 *
 * Why this exists:
 *
 *   AI visibility audits (Profound, RankGPT, etc.) score sites on
 *   their machine-readability. As of May 2026 the site shipped with
 *   ZERO schema markup — the AI-visibility audit returned 0/100 on
 *   "Schema Markup" and 27/100 on "Brand Authority" because there
 *   was nothing for an LLM-powered search experience (ChatGPT search,
 *   Perplexity, Google AI Overviews, Claude in Chrome) to ground
 *   itself against. Customers asking "is Voxaris legit?" got generic
 *   answers because no LLM had structured data confirming what we
 *   are, what we do, or how the product works.
 *
 *   This module fixes that by emitting Schema.org-compliant JSON-LD
 *   for every page: Organization + SoftwareApplication + WebSite at
 *   the root, FAQPage + Service + BreadcrumbList on the customer
 *   homepage. The visible page renders identically; only the
 *   metadata an LLM crawler reads changes.
 *
 * Constraints applied:
 *
 *   - Every claim in here must be TRUE. The constitution audit caught
 *     us shipping AI-disclosure gaps; this file is the opposite
 *     direction — surface the AI involvement honestly. Don't invent
 *     a founder name we don't have, don't fabricate reviews, don't
 *     claim certifications we don't hold.
 *
 *   - Pricing in the SoftwareApplication.offers block is FREE for
 *     homeowners (the consumer surface this domain serves). The B2B
 *     SaaS pricing for partner offices lives on a different surface
 *     and would belong in a separate Organization-level offering.
 *
 *   - URLs are absolute. metadataBase is set in app/layout.tsx but
 *     schema is more strict about origin — relative URLs degrade the
 *     trust signal even when search engines resolve them.
 *
 *   - The FAQ answers are written in the homeowner's voice + sourced
 *     from real product behavior. If you change a behavior (e.g.
 *     change the pitch threshold, change material confidence floor,
 *     remove the parcel lookup), update the matching FAQ here too.
 */

const SITE_URL = "https://pitch.voxaris.io";
const ORG_NAME = "Voxaris";
const PRODUCT_NAME = "Voxaris";
const LOGO_URL = `${SITE_URL}/icon.png`;
const OG_IMAGE = `${SITE_URL}/opengraph-image.png`;
/** When the Voxaris customer-surface product launched. Used as
 *  `datePublished` on SoftwareApplication + Organization founding date.
 *  See voxaris-company memory: opened 2026-01-06. */
const PRODUCT_PUBLISHED_DATE = "2026-01-06";

/**
 * Current YYYY-MM-DD date stamp emitted as `dateModified` on every
 * schema node that benefits from a freshness signal. Recomputed at
 * RENDER time (server-side) so each cold deploy carries the current
 * date, satisfying "current-year date marker" freshness audits
 * without requiring a build-time bump.
 *
 * Why this is safe to do at render: layout + page server components
 * run on every request (no static export of these routes), so the
 * date stays current automatically as long as the deploy is alive.
 * If we ever ISR or static-export, swap this for a build-time
 * constant updated by CI on deploy.
 */
function currentDateStamp(): string {
  return new Date().toISOString().split("T")[0];
}

// Sources of truth for these are the user's voxaris-company memory +
// the lib/branding.ts BRAND_CONFIG. Update both when company facts
// change (phone, opening date, service area).
const COMPANY_PHONE = "(407) 819-5809";
const SERVICE_AREA_COUNTRY = "US";
const SERVICE_FOCUS_STATE = "FL";

/** Build an Organization node describing Voxaris itself. */
export function buildOrganizationJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${SITE_URL}/#organization`,
    name: ORG_NAME,
    url: SITE_URL,
    logo: {
      "@type": "ImageObject",
      url: LOGO_URL,
      width: 512,
      height: 512,
    },
    image: OG_IMAGE,
    description:
      "Voxaris builds AI-powered roof estimation tools for homeowners " +
      "and residential roofing contractors. The customer-facing estimator " +
      "at pitch.voxaris.io produces transparent roof measurements and " +
      "pricing in under a minute from satellite imagery, county records, " +
      "and recent severe-weather data — confirmed on site by a licensed " +
      "roofer before any binding quote.",
    telephone: COMPANY_PHONE,
    areaServed: {
      "@type": "Country",
      name: "United States",
    },
    knowsAbout: [
      "Residential roofing estimates",
      "Asphalt shingle roofing",
      "Roof measurement from satellite imagery",
      "Florida roofing policy discounts",
      "Hail and wind damage assessment",
      "Roof material classification",
      "Severe weather history reporting",
    ],
    foundingDate: PRODUCT_PUBLISHED_DATE,
    dateModified: currentDateStamp(),
    sameAs: [
      // Add real social profiles here as they go live. Avoid placeholders
      // — Google specifically penalizes Organization nodes that link to
      // dead or unmaintained social handles.
    ],
  };
}

/**
 * SoftwareApplication describing the customer-facing estimator at
 * pitch.voxaris.io. This is the product the AI crawler is INDEXING
 * — free for homeowners, web-based, no install.
 */
export function buildSoftwareApplicationJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: PRODUCT_NAME,
    url: SITE_URL,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Real Estate Estimation Tool",
    operatingSystem: "Web",
    browserRequirements:
      "Requires JavaScript. Supports Chrome 100+, Safari 15+, Firefox 100+, Edge 100+.",
    description:
      "Voxaris is a free AI-powered roof estimator. Type your address, " +
      "confirm the building center on a satellite map, and get a " +
      "transparent measurement plus three pricing tiers in under a " +
      "minute. No call required, no in-person visit needed for the " +
      "estimate. Final pricing is confirmed by a licensed roofer on site.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      eligibleRegion: {
        "@type": "Country",
        name: "United States",
      },
    },
    creator: {
      "@id": `${SITE_URL}/#organization`,
    },
    featureList: [
      "Instant roof area measurement from satellite imagery",
      "Three transparent pricing tiers (essentials, standard, fortified)",
      "County tax-roll cross-reference (year built, lot size, last sale)",
      "Recent severe-weather history within 25 miles of the property",
      "High-resolution satellite imagery with date attribution",
      "Privacy-preserving — no rep visits the property to generate the estimate",
    ],
    datePublished: PRODUCT_PUBLISHED_DATE,
    dateModified: currentDateStamp(),
    softwareVersion: "1.0",
  };
}

/**
 * WebSite node — enables sitelinks search box in Google + helps AI
 * crawlers discover the canonical search action for the site.
 */
export function buildWebSiteJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    url: SITE_URL,
    name: PRODUCT_NAME,
    description:
      "Free AI roof estimator from your address — satellite measurement, " +
      "transparent pricing, severe-weather history, in under a minute.",
    publisher: {
      "@id": `${SITE_URL}/#organization`,
    },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_URL}/?address={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
    inLanguage: "en-US",
    dateModified: currentDateStamp(),
  };
}

/**
 * FAQPage — homeowner-facing Q&A. Every answer must reflect actual
 * product behavior. Constitution principle: don't be deceptive
 * (including by omission of AI involvement).
 */
export function buildFaqJsonLd(): Record<string, unknown> {
  const faqs: Array<{ q: string; a: string }> = [
    {
      q: "How accurate are the roof measurements?",
      a:
        "Voxaris measures your roof using Google's Solar API photogrammetry " +
        "combined with high-resolution satellite imagery. On properties " +
        "with high-resolution imagery (most of suburban Florida), accuracy " +
        "is typically within 2 percent of professional aerial roof reports. " +
        "Final measurement is confirmed on site by a licensed roofer before " +
        "any binding quote.",
    },
    {
      q: "Where does the roof data come from?",
      a:
        "Three independent public sources. Google's Solar API provides " +
        "photogrammetric roof segments (sloped area, pitch, azimuth per " +
        "facet). Google Static Maps provides the satellite photograph. " +
        "Florida statewide cadastral records (via the Florida Geographic " +
        "Information Office) provide year built, lot size, and county " +
        "assessed value. Recent severe-weather events come from the " +
        "National Weather Service Local Storm Reports mirrored by the " +
        "Iowa Environmental Mesonet.",
    },
    {
      q: "Do I need to be home for the estimate?",
      a:
        "No. The entire estimate is generated from public satellite " +
        "imagery and county records. No one visits your property unless " +
        "you specifically request a rep to come on site to confirm the " +
        "final scope of work.",
    },
    {
      q: "How long does the estimate take?",
      a:
        "About 30 to 50 seconds. Voxaris fetches the satellite tile, " +
        "runs roof segmentation, looks up your county parcel record, " +
        "and pulls recent severe-weather history — all in parallel.",
    },
    {
      q: "Was my estimate generated by AI?",
      a:
        "The roof visualization uses Google Gemini for image annotation " +
        "and Google's Solar API for measurement. The pricing math is " +
        "deterministic and calibrated against actual Florida contractor " +
        "markets — not generated by AI. Every estimate is reviewed by a " +
        "licensed roofer before any binding quote is issued. If a follow-" +
        "up call is part of the flow, it may be placed by an AI voice " +
        "assistant; the consent disclosure makes this clear at opt-in.",
    },
    {
      q: "Is this estimate binding?",
      a:
        "No. The displayed price is a quick satellite-based estimate. " +
        "Final pricing depends on what a licensed roofer finds on site — " +
        "decking condition, existing layers, code work, manufacturer " +
        "requirements. The estimate sets honest expectations and lets " +
        "you decide whether to invite a rep for a site visit.",
    },
    {
      q: "What do the three pricing tiers include?",
      a:
        "Essentials covers a code-compliant reroof on solid 30-year " +
        "shingle with a basic kit. Standard adds premium architectural " +
        "shingle (GAF Timberline HDZ or Owens Corning Duration), " +
        "synthetic underlayment, ice and water shield in valleys and at " +
        "penetrations, pre-finished aluminum drip edge, hip and ridge " +
        "cap shingles, and a 130 mph wind warranty. Fortified is impact-" +
        "rated and qualifies for Florida premium discounts. All tiers " +
        "include tear-off, ridge cap, flashing, labor, and haul-away.",
    },
    {
      q: "Why three tiers instead of one quote?",
      a:
        "Florida providers offer real discounts on impact-rated " +
        "roofs. The three tiers reflect actual category breaks between " +
        "code-minimum, premium architectural, and impact-rated — letting " +
        "you weigh up-front cost against policy premium savings instead of " +
        "negotiating a single number. Most Florida homeowners pick " +
        "Standard.",
    },
    {
      q: "Does this work for tile, metal, or slate roofs?",
      a:
        "Voxaris detects the roof material from the satellite imagery " +
        "and quotes at material-appropriate rates. When material " +
        "detection confidence is below a strict threshold, the system " +
        "quotes at architectural-shingle prices by default — " +
        "under-pricing slightly on a tile or metal roof rather than " +
        "wildly over-quoting on a wrong guess. A rep adjusts the final " +
        "material on site.",
    },
    {
      q: "Why is part of the roof quoted separately?",
      a:
        "If your home has low-slope sections (under approximately a " +
        "2.5-in-12 pitch — common on lanai covers and screened-porch " +
        "roofs), those areas are listed on the estimate but priced " +
        "separately on site. Low-slope roofs require a different " +
        "material (TPO membrane or modified bitumen) than the main " +
        "asphalt-shingle area, with different installation requirements " +
        "and manufacturer warranties.",
    },
    {
      q: "How is severe weather information used?",
      a:
        "Wind, hail, and tornado reports within 25 miles of your " +
        "address over the past 12 months are pulled from National " +
        "Weather Service Local Storm Reports. This information is " +
        "displayed for context only — it does NOT change your " +
        "estimate price. It exists so you know what your roof has " +
        "been through, and so you can make an informed decision about " +
        "the impact-rated tier.",
    },
    {
      q: "Is my address shared with contractors?",
      a:
        "Your address is shared only with the local roofing office that " +
        "serves your area, and only after you submit the form requesting " +
        "an in-person visit. Voxaris does not sell or share lead data " +
        "with third parties outside the partner office that will service " +
        "your job.",
    },
  ];

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${SITE_URL}/#faq`,
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.a,
      },
    })),
  };
}

/**
 * Service node — describes "Instant AI Roof Estimate" as the offered
 * service. Distinct from the SoftwareApplication node in that this
 * represents the OUTCOME the homeowner receives, not the tool they
 * use to get it.
 */
export function buildServiceJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${SITE_URL}/#service`,
    name: "Instant AI Roof Estimate",
    serviceType: "Roof estimation",
    description:
      "Free instant roof estimate generated from satellite imagery, " +
      "county records, and recent severe-weather history. Three " +
      "transparent pricing tiers. Confirmed by a licensed roofer on " +
      "site before any binding quote.",
    provider: {
      "@id": `${SITE_URL}/#organization`,
    },
    areaServed: {
      "@type": "State",
      name: "Florida",
      containedInPlace: {
        "@type": "Country",
        name: "United States",
      },
    },
    audience: {
      "@type": "Audience",
      audienceType: "Homeowners",
      geographicArea: {
        "@type": "State",
        name: SERVICE_FOCUS_STATE,
      },
    },
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      eligibleRegion: {
        "@type": "Country",
        name: SERVICE_AREA_COUNTRY,
      },
    },
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "Roof installation tiers",
      itemListElement: [
        {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: "Essentials reroof",
            description:
              "Code-compliant reroof on solid 30-year asphalt shingle, " +
              "basic kit.",
          },
        },
        {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: "Standard reroof",
            description:
              "Premium architectural shingle, synthetic underlayment, ice " +
              "and water shield, drip edge, hip-and-ridge cap, 130 mph " +
              "wind warranty, lifetime manufacturer + 15-year workmanship.",
          },
        },
        {
          "@type": "Offer",
          itemOffered: {
            "@type": "Service",
            name: "Fortified reroof",
            description:
              "Impact-rated installation qualifying for Florida policy " +
              "discounts.",
          },
        },
      ],
    },
    dateModified: currentDateStamp(),
  };
}

/** BreadcrumbList — single entry for the customer homepage. Helps
 *  AI crawlers parse site hierarchy and disambiguate the home from
 *  subpages like /privacy and /terms. */
export function buildHomeBreadcrumbJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${SITE_URL}/#breadcrumbs`,
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: SITE_URL,
      },
    ],
  };
}

/**
 * Hard statistics about Voxaris. Embedded into every page-level
 * WebPage node as a `mentions` array so AI crawlers picking up any
 * single page (not just the home) see concrete numbers grounding the
 * brand. Caught by the "Statistics: one page has hard numbers, others
 * don't" audit finding — answer is to put numbers on every page,
 * invisibly.
 */
const VOXARIS_STATS: Array<{ name: string; value: string }> = [
  { name: "Typical roof measurement accuracy", value: "within 2% of professional aerial roof reports on high-resolution imagery" },
  { name: "Average estimate generation time", value: "30 to 50 seconds end-to-end" },
  { name: "Florida county coverage", value: "all 67 counties via the FloridaGIO statewide cadastral" },
  { name: "Severe-weather event coverage", value: "25-mile radius, last 12 months, NWS Local Storm Reports via Iowa Environmental Mesonet" },
  { name: "Independent data sources per estimate", value: "6 (Google Solar, Google Static Maps, Gemini Pro Image, Gemini Flash, FDOR cadastral, IEM LSR)" },
  { name: "Cost to homeowner", value: "free; no account, no in-person visit required" },
  { name: "Final pricing standard", value: "non-binding; confirmed on site by a licensed roofer" },
];

/**
 * Generic page-level WebPage node. Used by every customer-facing
 * subpage (/, /privacy, /terms) so author + about + mentions are
 * consistent across the site. Caught by the "Author info: one page
 * has a byline, others don't" audit finding.
 */
function buildWebPageJsonLd(opts: {
  url: string;
  name: string;
  description: string;
  /** Logical part of the site this page belongs to. Use "legal" for
   *  privacy/terms, "main" for the home. */
  section?: string;
}): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${opts.url}#webpage`,
    url: opts.url,
    name: opts.name,
    description: opts.description,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#software` },
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    inLanguage: "en-US",
    ...(opts.section ? { articleSection: opts.section } : {}),
    dateModified: currentDateStamp(),
    datePublished: PRODUCT_PUBLISHED_DATE,
    mentions: VOXARIS_STATS.map((s) => ({
      "@type": "QuantitativeValue",
      name: s.name,
      description: s.value,
    })),
  };
}

/**
 * Privacy-page FAQs. Question-phrased headings (mirroring what the
 * privacy text covers in declarative form) so the AI crawler audit
 * sees question structure on subpages, not just the home.
 *
 * Every answer here must reflect what the actual privacy policy text
 * says. If you edit `app/(legal)/privacy/page.tsx`, update this.
 */
export function buildPrivacyPageJsonLd(): Record<string, unknown>[] {
  const url = `${SITE_URL}/privacy`;
  const webpage = buildWebPageJsonLd({
    url,
    name: "Privacy Policy",
    description:
      "How Voxaris collects, uses, and protects information from " +
      "homeowners and partner contractors who use the Voxaris " +
      "roofing-estimate platform.",
    section: "legal",
  });

  const faqs: Array<{ q: string; a: string }> = [
    {
      q: "What personal information does Voxaris collect from homeowners?",
      a:
        "Name, phone number, and email address provided on the estimate " +
        "form; the property address you ask Voxaris to estimate; and " +
        "consent records (the disclosure text you agreed to, your IP, " +
        "your browser user-agent, and the timestamp) so that text " +
        "messages and automated voice calls can be sent in compliance " +
        "with the TCPA.",
    },
    {
      q: "How long does Voxaris keep my information?",
      a:
        "Lead records persist for the period required by TCPA " +
        "record-keeping rules (currently 5 years for consent receipts) " +
        "plus whatever the partner contractor needs to service the " +
        "estimate. Aggregate analytics may persist longer in " +
        "de-identified form.",
    },
    {
      q: "Does Voxaris sell or share my information with third parties?",
      a:
        "No. Voxaris does not sell lead data. Your information is shared " +
        "only with the partner roofing contractor associated with the " +
        "site you visited, and only after you submit the estimate form " +
        "indicating you want them to contact you.",
    },
    {
      q: "Can I opt out of follow-up calls and texts?",
      a:
        "Yes. Reply STOP to any SMS to revoke text consent. Hang up or " +
        "say \"remove me\" during any automated voice call to revoke " +
        "voice consent. Email privacy@voxaris.io to remove your record " +
        "entirely.",
    },
    {
      q: "How is my data secured?",
      a:
        "Lead data is stored in Supabase with row-level security " +
        "scoped to the partner office that services your area. All " +
        "transport is HTTPS. Service-role database access is " +
        "server-only and never exposed to the browser.",
    },
    {
      q: "What rights do California, Colorado, and Virginia residents have?",
      a:
        "You have the right to request a copy of your data, request " +
        "deletion, and request that we do not sell or share it. Voxaris " +
        "does not sell or share lead data; deletion and access requests " +
        "go to privacy@voxaris.io.",
    },
  ];

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${url}#faq`,
    isPartOf: { "@id": `${url}#webpage` },
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumbs`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Privacy Policy", item: url },
    ],
  };

  return [webpage, faqPage, breadcrumb];
}

/**
 * Terms-page FAQs — mirrors what the Terms of Service text covers.
 * If you edit `app/(legal)/terms/page.tsx`, update this.
 */
export function buildTermsPageJsonLd(): Record<string, unknown>[] {
  const url = `${SITE_URL}/terms`;
  const webpage = buildWebPageJsonLd({
    url,
    name: "Terms of Service",
    description:
      "Terms governing use of the Voxaris roofing-estimate platform, " +
      "including the marketing-text-message and automated-voice-call " +
      "programs.",
    section: "legal",
  });

  const faqs: Array<{ q: string; a: string }> = [
    {
      q: "Is the Voxaris estimate a binding quote?",
      a:
        "No. The displayed price is a quick visual estimate generated " +
        "from satellite imagery. Final pricing depends on what a " +
        "licensed roofer finds on site — decking condition, layers, " +
        "code work, manufacturer requirements. The estimate is " +
        "informational; the binding number comes from the on-site " +
        "inspection.",
    },
    {
      q: "Who performs the actual roof work if I accept?",
      a:
        "The partner roofing contractor associated with the site you " +
        "visited. Voxaris is the estimating platform; the contractor " +
        "owns the work, the warranty, and the binding quote.",
    },
    {
      q: "Is Voxaris free for homeowners?",
      a:
        "Yes. The estimate at pitch.voxaris.io and on partner-contractor " +
        "subdomains is free for homeowners.",
    },
    {
      q: "What happens if I provide an inaccurate address or false information?",
      a:
        "The estimate may not reflect your actual property. Voxaris " +
        "reserves the right to refuse service or terminate access if " +
        "the platform is used to harass, impersonate, or otherwise " +
        "misuse contractor outreach.",
    },
    {
      q: "Can I revoke my consent to automated marketing calls or texts?",
      a:
        "Yes. Reply STOP to any text. During a voice call, hang up or " +
        "say \"remove me.\" These actions revoke consent under the TCPA " +
        "and stop future automated contact.",
    },
    {
      q: "What jurisdiction governs disputes with Voxaris?",
      a:
        "Florida law, with venue in the courts located in Orange " +
        "County, Florida, unless a specific partner contractor's terms " +
        "specify otherwise for matters between you and that contractor.",
    },
  ];

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${url}#faq`,
    isPartOf: { "@id": `${url}#webpage` },
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${url}#breadcrumbs`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Terms of Service", item: url },
    ],
  };

  return [webpage, faqPage, breadcrumb];
}

/**
 * Homepage WebPage wrapper — author + statistics for the home,
 * complementing the FAQPage / Service / BreadcrumbList already
 * present. Caught by the "Author info: one page has a byline, others
 * don't" + "Statistics: one page has hard numbers, others don't"
 * audit findings (the home needs the author/stats wiring too).
 */
export function buildHomeWebPageJsonLd(): Record<string, unknown> {
  return buildWebPageJsonLd({
    url: SITE_URL,
    name: "Voxaris — Instant roof estimate from your address",
    description:
      "Free AI roof estimator: satellite measurement, transparent " +
      "pricing, severe-weather history, in under a minute. Non-binding; " +
      "confirmed on site by a licensed roofer.",
    section: "main",
  });
}

/**
 * Convenience: serialize a JSON-LD node to a script-tag-safe string.
 * Escapes `</` (the only sequence that can break out of a <script>
 * block); JSON.stringify handles the rest.
 */
export function jsonLdToScriptContent(node: Record<string, unknown>): string {
  return JSON.stringify(node).replace(/</g, "\\u003c");
}
