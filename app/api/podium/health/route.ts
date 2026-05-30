import { NextResponse } from "next/server";
import { checkPodiumRead, minePodiumVoice } from "@/lib/podium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/podium/health?secret=... — operator-only probe that confirms
 * the current PODIUM_ACCESS_TOKEN actually authenticates against Podium
 * and can READ conversations (for brand-voice mining). Returns only HTTP
 * statuses + a conversation count — never message content / PII.
 *
 * Gated by PODIUM_HEALTH_SECRET (a throwaway operator secret) so it isn't
 * a public surface. Returns 404 when the secret env is unset (route is
 * effectively disabled until an operator opts in).
 */
export async function GET(req: Request): Promise<Response> {
  const expected = process.env.PODIUM_HEALTH_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  const secret = params.get("secret");
  if (secret !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // ?mine=N runs the transient voice-mining pull (operator-only, gated).
  const mine = params.get("mine");
  if (mine) {
    const result = await minePodiumVoice(Number(mine) || 15);
    return NextResponse.json(result);
  }
  const health = await checkPodiumRead();
  return NextResponse.json(health);
}
