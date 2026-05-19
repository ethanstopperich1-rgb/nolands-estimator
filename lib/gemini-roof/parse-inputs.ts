import { NextResponse } from "next/server";

export interface ParsedGeminiRoofInputs {
  lat: number;
  lng: number;
  address: string | null;
  skipCache: boolean;
  pinConfirmed: boolean;
  debug: boolean;
  leadPublicId: string | null;
}

export function parseGeminiRoofInputs(
  req: Request,
  body: unknown,
): ParsedGeminiRoofInputs | NextResponse {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lng = Number(u.searchParams.get("lng"));
    const address = u.searchParams.get("address");
    const skipCache = u.searchParams.get("skipCache") === "1";
    const pinConfirmed = u.searchParams.get("pinConfirmed") === "1";
    const debug = u.searchParams.get("debug") === "1";
    const leadPublicId = u.searchParams.get("leadPublicId");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
    }
    return {
      lat,
      lng,
      address,
      skipCache,
      pinConfirmed,
      debug,
      leadPublicId:
        leadPublicId && /^lead_[0-9a-f]{32}$/i.test(leadPublicId) ? leadPublicId : null,
    };
  }
  const b = body as {
    lat?: number;
    lng?: number;
    address?: string;
    skipCache?: boolean;
    pinConfirmed?: boolean;
    debug?: boolean;
    leadPublicId?: string;
  };
  if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  return {
    lat: Number(b.lat),
    lng: Number(b.lng),
    address: b.address ?? null,
    skipCache: !!b.skipCache,
    pinConfirmed: !!b.pinConfirmed,
    debug: !!b.debug,
    leadPublicId:
      typeof b.leadPublicId === "string" && /^lead_[0-9a-f]{32}$/i.test(b.leadPublicId)
        ? b.leadPublicId
        : null,
  };
}
