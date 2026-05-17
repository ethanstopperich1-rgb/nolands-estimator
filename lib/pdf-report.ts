/**
 * lib/pdf-report.ts — Playwright-rendered EagleView-style PDF.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Why playwright-core + @sparticuz/chromium on Vercel?               │
 * │                                                                     │
 * │  The full `playwright` npm package bundles a 280MB Chromium build   │
 * │  in `node_modules/playwright/.local-browsers`. Vercel serverless    │
 * │  functions cap unzipped deploy size at 250MB — `playwright` alone   │
 * │  blows past that and the build fails before it even ships.          │
 * │                                                                     │
 * │  `playwright-core` is the same Node API surface MINUS the bundled   │
 * │  browser. We pair it with `@sparticuz/chromium`, an AWS-Lambda /    │
 * │  Vercel-tuned headless chromium tarball (≈55MB compressed) that     │
 * │  ships its own launch args + font set, and point Playwright at      │
 * │  `executablePath` at runtime.                                       │
 * │                                                                     │
 * │  In dev we want the full Playwright with its own bundled Chromium   │
 * │  Headless Shell (downloaded once via `npx playwright install        │
 * │  chromium`) so engineers don't need to fight Sparticuz locally.     │
 * │                                                                     │
 * │  Detection: `process.env.VERCEL === "1"` is set on every Vercel     │
 * │  build + runtime, including preview deploys. Local dev never has    │
 * │  it. We branch on that.                                             │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import type { Browser, LaunchOptions } from "playwright-core";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

// Singleton browser. Booting Chromium is ~800ms cold; reusing across
// requests inside the same lambda container drops that to ~5ms per PDF.
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;

  const isVercel = process.env.VERCEL === "1";

  if (isVercel) {
    // Serverless path — minimal Chromium from @sparticuz/chromium.
    // Dynamic import so dev machines never resolve the module if they
    // don't have it installed in a fresh clone.
    const [{ chromium: pwCore }, sparticuzMod] = await Promise.all([
      import("playwright-core"),
      import("@sparticuz/chromium"),
    ]);
    // `@sparticuz/chromium` is `export default Chromium;` — under
    // verbatimModuleSyntax / NodeNext, dynamic import wraps that into
    // `{ default: Chromium }`. The fallback (`?? sparticuzMod`) covers
    // bundlers that hoist the default to the module root.
    const sparticuz =
      (sparticuzMod as unknown as { default?: { args: string[]; executablePath: () => Promise<string> } })
        .default ??
      (sparticuzMod as unknown as { args: string[]; executablePath: () => Promise<string> });

    const launchArgs: LaunchOptions = {
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
      headless: true,
    };
    browser = await pwCore.launch(launchArgs);
    return browser;
  }

  // Dev path — full Playwright with its bundled headless shell. Lazy
  // import so production bundles never pull in the dev-only module.
  const { chromium: pwFull } = await import("playwright");
  browser = await pwFull.launch({ headless: true });
  return browser;
}

/**
 * Render the report HTML at /internal/report/[publicId] and return a
 * Letter-sized PDF buffer. Caller owns the bytes — we don't write to
 * disk or storage here.
 */
export async function renderRoofReportPDF(
  publicId: string,
  baseUrl: string,
): Promise<Buffer> {
  if (!supabaseServiceRoleConfigured()) {
    throw new Error("supabase_service_role_unconfigured");
  }
  // Sanity-check the lead exists before spinning up a browser. Cheaper
  // 404 than a 30s headless render that ends in an empty page.
  const supabase = createServiceRoleClient();
  const { data: lead, error } = await supabase
    .from("leads")
    .select("public_id, roof_v3_json")
    .eq("public_id", publicId)
    .maybeSingle();
  if (error) throw new Error(`lead_lookup_failed: ${error.message}`);
  if (!lead) throw new Error("lead_not_found");
  if (!lead.roof_v3_json) throw new Error("lead_missing_roof_v3_json");

  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: 816, height: 1056 }, // 8.5×11in @ 96dpi
  });
  // Forward the rep's basic-auth so the protected /internal/report/* page
  // renders. Pulls from env so we don't need the rep's session cookie.
  const user = process.env.STAFF_AUTH_USER;
  const pass = process.env.STAFF_AUTH_PASS;
  if (user && pass) {
    await context.setExtraHTTPHeaders({
      Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    });
  }
  const page = await context.newPage();
  try {
    const url = `${baseUrl}/internal/report/${encodeURIComponent(publicId)}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    const pdf = await page.pdf({
      format: "Letter",
      margin: { top: "0.5in", bottom: "0.5in", left: "0.5in", right: "0.5in" },
      printBackground: true,
      preferCSSPageSize: false,
    });
    return pdf;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/**
 * Graceful shutdown hook. Vercel doesn't actually give us a
 * before-shutdown signal, but local dev + tests can call this to
 * avoid leaking Chromium processes between runs.
 */
export async function releaseBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
