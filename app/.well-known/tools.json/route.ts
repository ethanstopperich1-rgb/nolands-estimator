/**
 * /.well-known/tools.json — machine-readable agent-tools manifest.
 *
 * Future-proofs the AEO + WebMCP play. Modern AI agents (Perplexity,
 * Claude with file-search, OpenAI's web tools, the upcoming WebMCP
 * spec in Chrome) already look at `/.well-known/` paths for things
 * like `ai-plugin.json`, `llms.txt`, `robots.txt`. Publishing a
 * `tools.json` is the agent-equivalent of a sitemap: here's the
 * structured surface area we'd expose if you want to call it
 * programmatically instead of OCRing our HTML.
 *
 * Today none of these tools are LIVE in the WebMCP sense — Chrome's
 * `navigator.modelContext` API is behind a flag, origin trial 149.
 * What we ARE doing today is publishing the manifest so the next
 * wave of AI agents can discover us when they go looking. Voxaris
 * shows up as a TOOL in ChatGPT/Perplexity/Gemini, not just as a
 * page they can't figure out how to fill out.
 *
 * Per-office: the manifest is tenant-aware. When this same code
 * runs under `noland-roofing.com`, the office_name + phone + service
 * area auto-resolve to Noland's via the host header, so each
 * white-label deployment publishes its OWN tool manifest in the
 * contractor's brand.
 *
 * No PII, no signed URLs, no auth — this is a public discovery
 * document by design.
 */

import { NextResponse } from "next/server";
import { resolveOfficeBySlug, type OfficeBranding } from "@/lib/supabase";

export const runtime = "nodejs";
// Cache aggressively at the CDN — the manifest only changes when we
// rev the schema or add a new tool. 1 hour is plenty.
export const revalidate = 3600;

const SCHEMA_VERSION = "1.0.0";

interface ToolDescriptor {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  /** Where the tool is invokable: "web" (in-page WebMCP), "http"
   *  (REST endpoint), or "planned" (manifested but not yet live). */
  surface: "web" | "http" | "planned";
  /** Optional HTTP endpoint for non-WebMCP agents that want to call
   *  the same capability via REST. */
  endpoint?: string;
}

function resolveOriginFromRequest(req: Request): string {
  // Honor the Vercel project URL when running on Vercel, else fall
  // back to the inbound origin (handles preview branches + custom
  // subdomains).
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function resolveOfficeSlugFromHost(host: string): string {
  // For now we only resolve "voxaris" — when contractor subdomains
  // come online, parse them here. The pattern Brad set up uses
  // `<office>.voxaris.io` for white-label demos and the contractor's
  // own root domain for production deployments.
  if (host.endsWith(".voxaris.io")) {
    const sub = host.replace(".voxaris.io", "");
    if (sub && sub !== "pitch" && sub !== "www") return sub;
  }
  // TODO: per-office root-domain mapping table (offices.custom_domain
  // column) when that migration lands.
  return "voxaris";
}

export async function GET(req: Request) {
  const origin = resolveOriginFromRequest(req);
  const host = new URL(req.url).host;
  const slug = resolveOfficeSlugFromHost(host);

  const office: OfficeBranding | null = await resolveOfficeBySlug(slug).catch(
    () => null,
  );

  const displayName = office?.displayName ?? "Voxaris";
  const inboundNumber = office?.inboundNumber ?? null;

  const tools: ToolDescriptor[] = [
    {
      name: "get_roof_estimate",
      description:
        `Generate an instant roof estimate from satellite imagery for a US ` +
        `residential address. Returns measured sqft, painted overlay image ` +
        `URL, current material guess, and three replacement-tier prices ` +
        `(Good/Better/Best). Powered by Solar API + Gemini for measurement, ` +
        `tier prices via ${displayName}'s deterministic pricing math.`,
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description:
              "Full US residential address. Format: '8450 Oak Park Ave, Orlando FL 32827'.",
          },
        },
        required: ["address"],
      },
      surface: "planned",
      endpoint: `${origin}/api/gemini-roof`,
    },
    {
      name: "get_shared_report",
      description:
        `Read the structured roof report for a previously-captured lead by ` +
        `its public_id. Returns address, measured sqft, tier prices, ` +
        `severe-weather summary, parcel record, and condition observations. ` +
        `Same data the homeowner sees at /r/{publicId}, in machine-readable form.`,
      parameters: {
        type: "object",
        properties: {
          public_id: {
            type: "string",
            description:
              "The lead's public_id, e.g. 'lead_a3f8b9c2...'. Has ~128 bits of entropy; the URL bearer is the auth.",
          },
        },
        required: ["public_id"],
      },
      surface: "planned",
      endpoint: `${origin}/r/{public_id}`,
    },
    {
      name: "book_inspection",
      description:
        `Schedule a free on-site roof inspection with ${displayName}. ` +
        `Books an appointment with a licensed roofer; does NOT obligate ` +
        `the homeowner to buy. Requires the lead public_id (i.e. an ` +
        `estimate must already exist).`,
      parameters: {
        type: "object",
        properties: {
          public_id: {
            type: "string",
            description: "The lead's public_id.",
          },
          time_window: {
            type: "string",
            description:
              "Preferred window: 'morning' | 'afternoon' | 'evening', plus 2 day options. Example: 'morning Tue or Wed'.",
          },
        },
        required: ["public_id", "time_window"],
      },
      surface: "planned",
    },
    {
      name: "get_office_contact",
      description:
        `Return contact info for ${displayName} — display name, customer ` +
        `phone, service area, brand color. Use when an agent needs to ` +
        `surface 'how to reach this roofer' inside a chat answer.`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      surface: "http",
      endpoint: `${origin}/api/office/branding?slug=${slug}`,
    },
  ];

  // Stable, human-readable JSON output. Agents parse this; humans
  // may also visit the URL directly to audit what's exposed.
  const body = {
    schema_version: SCHEMA_VERSION,
    publisher: {
      name: displayName,
      origin,
      contact_phone: inboundNumber,
    },
    description:
      `${displayName} exposes structured tools for AI agents to ` +
      `measure roofs, read shared reports, and book on-site inspections. ` +
      `This manifest is the canonical discovery surface — Chrome WebMCP ` +
      `(origin trial 149) will register these same tools in-page once it ` +
      `lands. Until then, agents may call the listed HTTP endpoints.`,
    docs_url: "https://developer.chrome.com/docs/ai/webmcp",
    tools,
    // Per-tenant routing hint: agents that fan out across multiple
    // subdomains can use this to know they're on a white-label
    // deployment, not the Voxaris demo.
    tenant: { slug, white_label: slug !== "voxaris" },
    generated_at: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    headers: {
      // Long-cache at the CDN — manifest changes are rare. The
      // revalidate export above handles ISR-style refresh.
      "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
      // Standard Content-Type for tool manifests. Some agents probe
      // for `application/json` + the `tools.json` filename.
      "content-type": "application/json; charset=utf-8",
    },
  });
}
