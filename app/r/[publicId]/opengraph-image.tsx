/**
 * /r/[publicId]/opengraph-image — auto-generated OG preview card.
 *
 * Renders as a 1200×630 PNG via Next.js's `ImageResponse` (no
 * Chromium needed, runs in the standard Node runtime). This is what
 * shows up when a homeowner pastes the share URL into iMessage,
 * WhatsApp, Twitter, Facebook, LinkedIn, or any modern messenger.
 *
 * Design rule: must read at thumbnail size on a phone preview. Big
 * dollar range, address, office name. No fluff.
 */

import { ImageResponse } from "next/og";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const alt = "Roof report";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage({
  params,
}: {
  params: { publicId: string };
}) {
  let address = "Your roof report";
  let dollarRange = "";
  let officeName = "Voxaris";
  let accent = "#0F1B2D";

  if (
    /^lead_[a-f0-9]{16,40}$/i.test(params.publicId) &&
    supabaseServiceRoleConfigured()
  ) {
    try {
      const sb = createServiceRoleClient();
      const { data: lead } = await sb
        .from("leads")
        .select("address, estimate_low, estimate_high, office_id")
        .eq("public_id", params.publicId)
        .maybeSingle();

      if (lead) {
        address = lead.address;
        if (lead.estimate_low != null && lead.estimate_high != null) {
          dollarRange = `$${lead.estimate_low.toLocaleString()} – $${lead.estimate_high.toLocaleString()}`;
        }
        const { data: office } = await sb
          .from("offices")
          .select("name, brand_color")
          .eq("id", lead.office_id)
          .maybeSingle();
        if (office) {
          officeName = office.name ?? officeName;
          if (office.brand_color) {
            accent = `#${office.brand_color.replace(/^#/, "")}`;
          }
        }
      }
    } catch {
      // Fall through to defaults — never let an OG render fail noisily.
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "60px 70px",
          background: "#ECE3D0",
          color: "#0F1B2D",
          fontFamily: "DM Sans, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: accent,
              opacity: 0.75,
            }}
          >
            {officeName} — Roof Report
          </div>
          <div
            style={{
              fontSize: 56,
              fontWeight: 600,
              lineHeight: 1.1,
              letterSpacing: "-0.015em",
              maxWidth: 1000,
              display: "flex",
            }}
          >
            {address}
          </div>
        </div>

        {dollarRange ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                opacity: 0.55,
              }}
            >
              Estimate range
            </div>
            <div
              style={{
                fontSize: 88,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: accent,
                display: "flex",
              }}
            >
              {dollarRange}
            </div>
          </div>
        ) : (
          <div
            style={{
              fontSize: 32,
              fontWeight: 500,
              opacity: 0.65,
              display: "flex",
            }}
          >
            Roof measurements + tier pricing from satellite imagery.
          </div>
        )}
      </div>
    ),
    size,
  );
}
