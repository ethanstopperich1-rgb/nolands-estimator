import { NextResponse } from "next/server";
import { guardPublicBillableRequest } from "@/lib/api-public-guard";
import { BRAND_CONFIG } from "@/lib/branding";
import { resolveOfficeBySlug, supabaseServiceRoleConfigured } from "@/lib/supabase";
import { buildMarketingConsentText } from "@/lib/tcpa-consent";
import { isValidOfficeSlug, normalizeOfficeSlug } from "@/lib/leads/validation";

export const runtime = "nodejs";

/**
 * GET /api/office/branding?office=nolands
 *
 * Public read of office display fields for customer UI (TCPA copy, accent).
 * Does not expose Twilio secrets or internal IDs beyond slug.
 */
export async function GET(req: Request) {
  const gated = await guardPublicBillableRequest(req, "standard");
  if (gated) return gated;

  const slug = normalizeOfficeSlug(new URL(req.url).searchParams.get("office"));
  if (!isValidOfficeSlug(slug)) {
    return NextResponse.json({ error: "invalid_office" }, { status: 400 });
  }

  if (supabaseServiceRoleConfigured()) {
    const office = await resolveOfficeBySlug(slug);
    if (office) {
      return NextResponse.json({
        slug: office.slug,
        displayName: office.displayName,
        brandColor: office.brandColor,
        logoUrl: office.logoUrl,
        inboundNumber: office.inboundNumber,
        marketingConsentText: buildMarketingConsentText(office.displayName),
      });
    }
    return NextResponse.json({ error: "unknown_office" }, { status: 404 });
  }

  return NextResponse.json({
    slug,
    displayName: BRAND_CONFIG.companyName,
    brandColor: BRAND_CONFIG.accentColor.replace("#", ""),
    logoUrl: null,
    inboundNumber: BRAND_CONFIG.phone || null,
    marketingConsentText: buildMarketingConsentText(BRAND_CONFIG.companyName),
  });
}
