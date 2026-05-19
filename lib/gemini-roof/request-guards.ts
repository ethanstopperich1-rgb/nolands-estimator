import { NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { assertAiSpendUnderCap } from "@/lib/cost-cap";
import { isStaffRequest } from "@/lib/staff-auth";
import { guardPublicBillableRequest } from "@/lib/api-public-guard";

/** Origin + expensive rate limit + daily AI cap + BotID. */
export async function guardGeminiRoofRequest(req: Request): Promise<NextResponse | null> {
  const gated = await guardPublicBillableRequest(req, "expensive");
  if (gated) return gated;

  const capGate = await assertAiSpendUnderCap();
  if (capGate) return capGate;

  const verdict = await checkBotId();
  if ("isBot" in verdict && verdict.isBot && !verdict.isVerifiedBot) {
    return NextResponse.json({ error: "Bot detected" }, { status: 403 });
  }

  return null;
}

/** Strip debug output for non-staff callers. */
export function sanitizeGeminiRoofDebug(req: Request, debug: boolean): boolean {
  if (!debug) return false;
  return isStaffRequest(req);
}
