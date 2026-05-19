/**
 * Guards for billable public GET routes (origin allowlist + rate limit).
 */

import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/origin-guard";
import { rateLimit } from "@/lib/ratelimit";

type Bucket = "standard" | "expensive";

/**
 * Returns a blocking NextResponse, or null when the request may proceed.
 */
export async function guardPublicBillableRequest(
  req: Request,
  bucket: Bucket = "standard",
): Promise<NextResponse | null> {
  const origin = checkOrigin(req);
  if (origin) return origin;
  return rateLimit(req, bucket);
}
