<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Roof report (in-platform only)

Reps view the full lead report inside the platform — drawer (the
`LeadDrawer` on `/dashboard/leads`) for a quick overview, full
workbench (`/dashboard/estimate?leadId=…`) for editing. PDF export
was removed in 2026-05 so the data stays attached to the lead row
and reps don't email static files around. If you need it back, the
prior implementation lived at `app/api/leads/[publicId]/report/route.ts`
+ `app/internal/report/[publicId]/page.tsx` + `lib/pdf-report.ts`
(check `git log -- lib/pdf-report.ts` to recover).
