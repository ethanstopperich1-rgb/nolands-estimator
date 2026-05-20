import { NextResponse } from "next/server";

// Minimal liveness probe for uptime monitors (UptimeRobot / Better
// Stack). Returns 200 unconditionally — if this route can serve, the
// Next.js server is up. Per-dependency probing lives elsewhere.
export const runtime = "nodejs";

export function GET(): NextResponse {
  return NextResponse.json(
    { ok: true, ts: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
