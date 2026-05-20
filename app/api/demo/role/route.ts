/**
 * POST /api/demo/role  { role: "rep" | "manager" | "admin" | "owner" | "staff" }
 *
 * Sets the `voxaris_demo_role` cookie so the public /demo surface can
 * preview each role's view without creating a real Supabase account.
 * Read by lib/dashboard.ts → getDashboardRole() on demo routes only;
 * the cookie is ignored everywhere else.
 *
 * No auth gate — this is a demo affordance. The cookie has zero effect
 * outside /demo because middleware sets x-voxaris-demo only on that path.
 */
import { NextResponse, type NextRequest } from "next/server";

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7d
const ALLOWED_ROLES = new Set(["rep", "staff", "manager", "admin", "owner"]);

export async function POST(req: NextRequest) {
  let role: unknown;
  try {
    const body = await req.json();
    role = body?.role;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
    return NextResponse.json({ ok: false, error: "invalid_role" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, role });
  // Demo cookie. Tightened from sameSite:"lax" → "strict" + secure
  // flag in production: the value is just a role name (read by the
  // /demo client to pick a UI variant) but stricter cookie semantics
  // are a cheap safety net against cross-site exfiltration via XSS on
  // some other Voxaris page. httpOnly stays false because the /demo
  // client reads the value via document.cookie to pick its variant.
  res.cookies.set({
    name: "voxaris_demo_role",
    value: role,
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
    httpOnly: false,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
