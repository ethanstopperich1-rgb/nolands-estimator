# Voxaris brand fonts

Per the Voxaris Brand System v1.0, two font files belong here:

- `DragonEF.otf` — display serif (headlines, brand mark, prominent
  numerics). Set via `--vx-font-display`.
- `Ambit-SemiBold.ttf` — geometric sans for UI (body, buttons,
  eyebrows, labels). Set via `--vx-font-ui`.

Both are licensed assets — never load from Google Fonts or a third-party
CDN. The `@font-face` declarations live in `app/globals.css` and
self-host these files via `/fonts/<file>`.

## Graceful fallback while files are absent

If the files aren't dropped in yet, the brand fonts gracefully degrade
to the existing next/font pair (Cormorant Garamond → DragonEF slot,
Hanken Grotesk → Ambit slot) via the font-family stack in
`globals.css`. The customer page remains laid out and readable; only
the typographic personality differs.

To activate the real brand fonts: drop the two files into this
directory. No code change required.

## Scope

These fonts are used by the customer-facing surface only — i.e.
everything under `.voxaris` scope: `/` (pitch.voxaris.io root), future
white-label subdomains, public legal pages, customer-facing PDF
exports.

The `/dashboard/*` chrome (theme-terminal, dark) is intentionally
excluded — different audience, different brand surface, different
typographic stack.
