<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Roof report PDF (EagleView-style)

- Route: `GET /api/leads/[publicId]/report` → streams a Letter-sized PDF.
- Template: `app/internal/report/[publicId]/page.tsx` (server component,
  rendered to PDF by headless Chromium via `lib/pdf-report.ts`).
- Runtime split: `playwright` (dev) vs `playwright-core` +
  `@sparticuz/chromium` (Vercel) — see the header comment in
  `lib/pdf-report.ts`. Branch on `process.env.VERCEL === "1"`.
- Auth: `/internal/*` is in `PROTECTED_PAGE_PREFIXES`; Playwright
  forwards Basic Auth via `STAFF_AUTH_USER` / `STAFF_AUTH_PASS`.
- A `vendor/playwright` shallow clone exists for reference only — it is
  in `.gitignore` and `tsconfig.exclude`. The runtime dep is the npm
  package, not the clone.
