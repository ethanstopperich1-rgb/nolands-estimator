/**
 * /r/[publicId] route segment loader.
 *
 * Shown during the SSR pause while the share page resolves the lead +
 * office row from Supabase and re-mints the painted-overlay URL. The
 * page itself is server-rendered and usually fast (<400ms), but the
 * homeowner clicked an SMS link — they're likely on LTE, mid-walk,
 * and any blank frame reads as "this contractor's site is broken."
 *
 * The skeleton mirrors the actual card layout (hero + painted image +
 * three secondary cards) so the layout doesn't shift when the real
 * content swaps in. `aria-busy` exposes loading state to screen
 * readers. `role="status"` makes the SR announce the loading state
 * once on focus.
 *
 * NOTE: copy is intentionally English-only. We don't know the
 * homeowner's `preferred_language` until the lead row loads (that's
 * the data the loading state is waiting for), and a brief "Loading
 * your roof report…" string is universally understood enough to be
 * acceptable in either language for the <400ms it's visible.
 */

export default function HomeownerShareLoading() {
  return (
    <main
      className="min-h-screen"
      style={{
        background: "var(--vx-cream, #ECE3D0)",
        color: "var(--vx-ink, #0F1B2D)",
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}
      aria-busy="true"
      aria-label="Loading roof report"
    >
      <div className="mx-auto max-w-3xl px-5 py-10">
        {/* Header skeleton — logo placeholder + call button placeholder */}
        <div className="flex items-center justify-between mb-8">
          <div className="h-8 w-32 rounded-md bg-black/[0.06] animate-pulse" />
          <div className="h-9 w-32 rounded-full bg-black/[0.06] animate-pulse" />
        </div>

        {/* Hero card skeleton — anchor, keep rounded-2xl to match real */}
        <section
          role="status"
          className="mb-6 p-6 rounded-2xl bg-white shadow-sm"
        >
          <div className="h-3 w-48 rounded bg-black/[0.06] animate-pulse mb-3" />
          <div className="h-7 w-3/4 rounded bg-black/[0.06] animate-pulse mb-4" />
          <div className="h-10 w-2/3 rounded bg-black/[0.08] animate-pulse mb-3" />
          <div className="h-3 w-3/5 rounded bg-black/[0.05] animate-pulse" />
          <span className="sr-only">Loading your roof report…</span>
        </section>

        {/* Painted satellite skeleton — anchor, keep rounded-2xl */}
        <div className="mb-6 rounded-2xl bg-black/[0.06] animate-pulse aspect-[16/10]" />

        {/* Secondary cards skeleton — rounded-xl matches real demoted cards */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="mb-6 p-6 rounded-xl bg-white shadow-sm"
            style={{ opacity: 1 - i * 0.15 }}
          >
            <div className="h-4 w-40 rounded bg-black/[0.06] animate-pulse mb-4" />
            <div className="space-y-2">
              <div className="h-3 w-full rounded bg-black/[0.05] animate-pulse" />
              <div className="h-3 w-5/6 rounded bg-black/[0.05] animate-pulse" />
              <div className="h-3 w-2/3 rounded bg-black/[0.05] animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
