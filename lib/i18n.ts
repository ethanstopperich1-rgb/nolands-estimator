/**
 * lib/i18n.ts — bilingual (EN/ES) string dictionary for Voxaris.
 *
 * Lightweight on purpose. No next-intl, no LinguiJS, no babel
 * plugins. Just two parallel object literals keyed by a stable
 * string id, plus a `t(key, lang)` helper.
 *
 * Why so light: 90% of the customer-facing copy is a fixed set of
 * ~40 strings (hero, form labels, card titles, CTAs, disclosure
 * footer, SMS bodies). Heavyweight i18n frameworks pay off when
 * you have hundreds of strings across many locales and a
 * translation-team workflow. We have ~40 strings, two locales,
 * and a founder doing the Spanish pass himself. KISS.
 *
 * ── Spanish discipline ──
 *
 * The Spanish copy below is Florida-natural — not Google Translate.
 * Targets the homeowner audience in Orlando / Tampa / Miami / Naples
 * markets where ~25-30% of homeowners prefer Spanish for important
 * decisions. Recommendations applied throughout:
 *
 *   - "tu" not "usted" — warmer, matches the brand voice. Roofers
 *     close at the kitchen table; this isn't bank-pitch formality.
 *   - Don't translate proper nouns ("Voxaris", "Sydney").
 *   - "Tu techo" not "Su tejado" — "techo" is the Florida-Latino
 *     vernacular for "roof"; "tejado" reads as Spain-Spanish.
 *   - "Cita" for "appointment" — universal across all LatAm Spanish.
 *   - "Asistente de voz AI" for FCC AI-voice-disclosure compliance.
 *     The Feb 2024 ruling requires explicit identification of AI
 *     voice in BOTH the language of consent capture AND any
 *     subsequent communication. "AI" as initials is acceptable per
 *     the FCC's plain-language guidance.
 *
 * ── Adding new keys ──
 *
 * 1. Add the key to BOTH `en` and `es` dictionaries. Missing-key
 *    fallback returns the key itself (loud, easy to spot in QA).
 * 2. Use `t("hero.headline", lang)` at the render site.
 * 3. Run a native-speaker pass on any new Spanish strings BEFORE
 *    they ship to production.
 */

export type Lang = "en" | "es";

export const DEFAULT_LANG: Lang = "en";

/**
 * Resolve language from a request — checks `?lang=es` query param,
 * `vx-lang` cookie, then `Accept-Language` header, then default.
 */
export function resolveLangFromRequest(req: Request): Lang {
  // Query param wins — explicit user choice from the toggle.
  try {
    const url = new URL(req.url);
    const qp = url.searchParams.get("lang");
    if (qp === "en" || qp === "es") return qp;
  } catch {
    /* fall through */
  }

  // Cookie carries the persisted toggle across navigations.
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookieMatch = /(?:^|;\s*)vx-lang=(en|es)\b/.exec(cookieHeader);
  if (cookieMatch) return cookieMatch[1] as Lang;

  // Browser language preference — Spanish-default users from FL
  // markets get the right experience on first load.
  const accept = req.headers.get("accept-language") ?? "";
  if (/^\s*es\b|,\s*es\b/i.test(accept)) return "es";

  return DEFAULT_LANG;
}

/**
 * Validate a string is a supported language. Returns the canonical
 * lang or null when invalid. Use on every API input that takes
 * `preferred_language` from a client.
 */
export function parseLang(input: unknown): Lang | null {
  if (input === "en" || input === "es") return input;
  return null;
}

// ─── Translation dictionaries ─────────────────────────────────────

const en = {
  // Hero / brand — match the actual customer page copy verbatim so
  // wiring t() in is a 1:1 swap with no copy regression. The headline
  // splits across two spans (the second is italic) by design.
  "hero.eyebrow": "Clermont's #1 choice · Severe Weather Specialists",
  "hero.headline.line1": "Get your roof priced",
  "hero.headline.line2": "in 30 seconds.",
  "hero.subhead.lead":
    "We measure your roof from satellite imagery and price it on the spot. Free, no obligation, no pressure.",
  "hero.subhead.close": "No callbacks until you ask.",

  // Address form — labels are sr-only (screen reader / autofill
  // heuristics) so they still need to translate even though sighted
  // homeowners don't see them.
  "form.address.label": "Property street address",
  "form.address.placeholder": "Begin typing your address…",
  "form.address.eta": "≈ 30 sec",
  "form.name.label": "Full name",
  "form.name.placeholder": "Your name",
  "form.email.label": "Email address",
  "form.email.placeholder": "Your email",
  "form.phone.label": "Phone number",
  "form.phone.placeholder": "Your number",
  "form.cta.estimate": "See my estimate",
  "form.cta.estimating": "Loading…",
  "form.foot.tagline": "Non-binding estimate · We never sell your info",

  // Consent
  "consent.marketing":
    "By submitting, you agree to be contacted about your roofing project.",
  "consent.voice.label":
    "Yes, call me with an AI voice assistant to schedule. I can hang up, say \"remove me,\" or reply STOP anytime.",
  "consent.stop": "Reply STOP to opt out.",
  "consent.privacy_link": "Privacy Policy",
  "consent.terms_link": "Terms of Service",
  "consent.recaptcha":
    "This site is protected by reCAPTCHA and the Google {privacyLink} and {termsLink} apply.",

  // Result page
  "result.eyebrow": "Your estimate",
  "result.tier.good": "Good",
  "result.tier.better": "Better",
  "result.tier.best": "Best",
  "result.tier.monthly": "est. {amount}/mo",
  "result.repcta.title": "Lock in your real number",
  "result.repcta.body":
    "A licensed roofer walks your property — exact sqft, decking condition, code work — and puts a written quote in your hand. Free, about 20 minutes, no obligation.",
  "result.repcta.button": "Lock in my real number",

  // Cards
  "card.severe_weather.title": "Severe weather, last 12 months",
  "card.property_record.title": "Property record",
  "card.measurements.title": "Roof measurements",
  "card.observations.title": "What we noticed from the imagery",

  // Disclosure / footer
  "disclosure.not_binding":
    "Not a final or binding quote. Quick visual estimate from satellite imagery. Final price depends on what we find on site (decking condition, layers, code work). Confirmed by a licensed roofer.",
  "disclosure.tier_coverage":
    "Tier prices above cover the full {sqft} sqft, priced as {material} with {waste}% waste assumed. Any flat-roof sections are adjusted on site.",
  "disclosure.financing":
    "Monthly est. assumes 15-year financing at 9.99% APR. Actual terms depend on credit + your finance partner.",

  // SMS bodies
  "sms.confirmation":
    "Hi {firstName}, this is {agentName} from {officeName}. We got your estimate request for {address}. {estimateLine}Your full report: {shareUrl} — keep it for your records. Reply YES and {agentName} (our AI voice assistant) will call you now to schedule a free inspection. Reply STOP to opt out.",
  "sms.estimate_range": "Your estimate range: ${low}-${high}. ",
  "sms.yes_ack":
    "Got it — {agentName} will call you in a few seconds from {officeName}.",
  "sms.postcall.appt_scheduled":
    "Hi {firstName}, your roof inspection with {officeName} is set for {when}. A rep will confirm shortly. Reply STOP to opt out.",
  "sms.postcall.callback_requested":
    "Hi {firstName}, thanks for chatting with us. A {officeName} rep will call you back shortly. Reply STOP to opt out.",
  "sms.postcall.voicemail":
    "Hi {firstName}, we just left you a voicemail. Reply YES to have us try again, or text us back any time. Reply STOP to opt out.",
  "sms.postcall.no_appointment":
    "Hi {firstName}, thanks for your time. If you'd like an estimate later, just reply here. Reply STOP to opt out.",

  // Language toggle
  "toggle.lang.label": "Language",
  "toggle.lang.en": "English",
  "toggle.lang.es": "Español",

  // Duplicate-submission UX
  "duplicate.headline": "We've already got your request.",
  "duplicate.body":
    "Your roof report is ready and a rep will be in touch. Tap below to re-open it.",
  "duplicate.cta": "Open my report",

  // /r/[publicId] homeowner share surface — copy the homeowner sees
  // when they open the white-labeled report link from SMS.
  "share.eyebrow_lead": "{firstName}, here's your roof report",
  "share.estimate_disclaimer":
    "Quick estimate range from satellite. Final price depends on what we find on site.",
  "share.measurements.sqft_measured": "Sqft (measured)",
  "share.measurements.current_material": "Current material",
  "share.tiers.title": "Three replacement options",
  "share.storms.events_within_25mi": "Events within 25 mi",
  "share.storms.hail_reports": "Hail reports",
  "share.storms.wind_reports": "Damaging-wind reports",
  "share.parcel.year_built": "Year built",
  "share.parcel.living_area": "Living area",
  "share.parcel.lot_size": "Lot size",
  "share.cta.kicker": "Ready for the real number?",
  "share.cta.headline": "Lock in a free 20-minute walkthrough",
  "share.cta.call_button": "Call {officeName}",
  "share.header.call_button": "Call {phone}",
  "share.footer.generated": "Report generated {date}",
  "share.footer.powered_by": "Powered by",
  "share.painted.alt": "Roof outlined from satellite imagery",
  "share.meta.title_fallback": "Roof report",
  "share.meta.title": "{address} — Roof report",
  "share.meta.description":
    "{officeName} measured this roof from satellite. Estimate range: {range}.",
  "share.meta.range_fallback": "your estimate",
} as const;

type StringKey = keyof typeof en;

const es: Record<StringKey, string> = {
  // Hero / brand — Florida-natural Spanish, "tu" not "usted",
  // "techo" not "tejado". Headline splits across two spans (second
  // italic) — same composition as English.
  "hero.eyebrow": "La #1 opción de Clermont · Especialistas en Clima Severo",
  "hero.headline.line1": "Conoce el precio de tu techo",
  "hero.headline.line2": "en 30 segundos.",
  "hero.subhead.lead":
    "Medimos tu techo desde imágenes satelitales y te damos el precio al instante. Gratis, sin compromiso, sin presión.",
  "hero.subhead.close": "Sin llamadas hasta que las pidas.",

  // Address form
  "form.address.label": "Dirección de la propiedad",
  "form.address.placeholder": "Escribe tu dirección…",
  "form.address.eta": "≈ 30 seg",
  "form.name.label": "Nombre completo",
  "form.name.placeholder": "Tu nombre",
  "form.email.label": "Correo electrónico",
  "form.email.placeholder": "Tu correo",
  "form.phone.label": "Teléfono",
  "form.phone.placeholder": "Tu teléfono",
  "form.cta.estimate": "Ver mi estimado",
  "form.cta.estimating": "Cargando…",
  "form.foot.tagline":
    "Estimado no vinculante · Nunca vendemos tu información",

  // Consent
  "consent.marketing":
    "Al enviar, aceptas que te contactemos sobre tu proyecto de techo.",
  "consent.voice.label":
    "Sí, llámame con un asistente de voz AI para agendar. Puedo colgar, decir \"quítenme\" o responder STOP en cualquier momento.",
  "consent.stop": "Responde STOP para no recibir más mensajes.",
  "consent.privacy_link": "Política de Privacidad",
  "consent.terms_link": "Términos de Servicio",
  "consent.recaptcha":
    "Este sitio está protegido por reCAPTCHA y aplican la {privacyLink} y los {termsLink} de Google.",

  // Result page
  "result.eyebrow": "Tu estimado",
  "result.tier.good": "Bueno",
  "result.tier.better": "Mejor",
  "result.tier.best": "Premium",
  "result.tier.monthly": "aprox. {amount}/mes",
  "result.repcta.title": "Asegura tu precio real",
  "result.repcta.body":
    "Un techador con licencia visita tu propiedad — pies cuadrados exactos, condición del entablado, trabajo de código — y te entrega una cotización por escrito. Gratis, unos 20 minutos, sin compromiso.",
  "result.repcta.button": "Asegurar mi precio real",

  // Cards
  "card.severe_weather.title": "Clima severo, últimos 12 meses",
  "card.property_record.title": "Registro de la propiedad",
  "card.measurements.title": "Medidas del techo",
  "card.observations.title": "Lo que notamos en las imágenes",

  // Disclosure / footer
  "disclosure.not_binding":
    "No es una cotización final ni vinculante. Estimado visual rápido de imágenes satelitales. El precio final depende de lo que encontremos en sitio (condición del entablado, capas, código). Confirmado por un techador con licencia.",
  "disclosure.tier_coverage":
    "Los precios cubren los {sqft} pies cuadrados completos, cotizados como {material} con {waste}% de desperdicio asumido. Las secciones de techo plano se ajustan en sitio.",
  "disclosure.financing":
    "Estimado mensual asume financiamiento a 15 años con 9.99% APR. Términos reales dependen del crédito y tu socio financiero.",

  // SMS bodies
  "sms.confirmation":
    "Hola {firstName}, soy {agentName} de {officeName}. Recibimos tu solicitud de estimado para {address}. {estimateLine}Tu reporte completo: {shareUrl} — guárdalo para tu archivo. Responde SÍ y {agentName} (nuestro asistente de voz AI) te llamará ahora para agendar una inspección gratis. Responde STOP para no recibir más mensajes.",
  "sms.estimate_range": "Tu rango estimado: ${low}-${high}. ",
  "sms.yes_ack":
    "Listo — {agentName} te llamará en unos segundos de parte de {officeName}.",
  "sms.postcall.appt_scheduled":
    "Hola {firstName}, tu inspección de techo con {officeName} está agendada para {when}. Un representante te confirmará pronto. Responde STOP para no recibir más mensajes.",
  "sms.postcall.callback_requested":
    "Hola {firstName}, gracias por hablar con nosotros. Un representante de {officeName} te llamará pronto. Responde STOP para no recibir más mensajes.",
  "sms.postcall.voicemail":
    "Hola {firstName}, te acabamos de dejar un mensaje de voz. Responde SÍ para intentarlo de nuevo, o escríbenos en cualquier momento. Responde STOP para no recibir más mensajes.",
  "sms.postcall.no_appointment":
    "Hola {firstName}, gracias por tu tiempo. Si quieres un estimado más adelante, responde aquí. Responde STOP para no recibir más mensajes.",

  // Language toggle
  "toggle.lang.label": "Idioma",
  "toggle.lang.en": "English",
  "toggle.lang.es": "Español",

  // Duplicate-submission UX
  "duplicate.headline": "Ya tenemos tu solicitud.",
  "duplicate.body":
    "Tu reporte de techo está listo y un representante se comunicará contigo. Toca aquí para volver a abrirlo.",
  "duplicate.cta": "Abrir mi reporte",

  // /r/[publicId] homeowner share surface — Florida-natural Spanish.
  // "techo" not "tejado", "tu" not "usted".
  "share.eyebrow_lead": "{firstName}, aquí está tu reporte de techo",
  "share.estimate_disclaimer":
    "Rango estimado rápido desde satélite. El precio final depende de lo que encontremos en sitio.",
  "share.measurements.sqft_measured": "Pies cuadrados (medidos)",
  "share.measurements.current_material": "Material actual",
  "share.tiers.title": "Tres opciones de reemplazo",
  "share.storms.events_within_25mi": "Eventos en 25 millas",
  "share.storms.hail_reports": "Reportes de granizo",
  "share.storms.wind_reports": "Reportes de viento dañino",
  "share.parcel.year_built": "Año de construcción",
  "share.parcel.living_area": "Área habitable",
  "share.parcel.lot_size": "Tamaño del lote",
  "share.cta.kicker": "¿Listo para el número real?",
  "share.cta.headline": "Agenda una visita gratis de 20 minutos",
  "share.cta.call_button": "Llamar a {officeName}",
  "share.header.call_button": "Llamar {phone}",
  "share.footer.generated": "Reporte generado {date}",
  "share.footer.powered_by": "Desarrollado por",
  "share.painted.alt": "Techo delineado desde imágenes satelitales",
  "share.meta.title_fallback": "Reporte de techo",
  "share.meta.title": "{address} — Reporte de techo",
  "share.meta.description":
    "{officeName} midió este techo desde satélite. Rango estimado: {range}.",
  "share.meta.range_fallback": "tu estimado",
};

const DICTIONARIES: Record<Lang, Record<StringKey, string>> = { en, es };

/**
 * Translate a key. Missing keys return the key itself (loud — easy
 * to spot in QA). Interpolation uses `{name}` placeholders replaced
 * by the `vars` map.
 */
export function t(
  key: StringKey,
  lang: Lang = DEFAULT_LANG,
  vars?: Record<string, string | number>,
): string {
  const dict = DICTIONARIES[lang] ?? DICTIONARIES[DEFAULT_LANG];
  const raw = dict[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => {
    const v = vars[name as string];
    return v == null ? match : String(v);
  });
}

/**
 * Bulk translator for the customer-page render. Returns a single
 * object with all the strings the page needs, avoiding 40+
 * inline `t()` calls in the JSX. Keeps the rendering site readable
 * and gives the typechecker a stable shape to lean on.
 */
export function customerPageStrings(lang: Lang = DEFAULT_LANG) {
  return Object.fromEntries(
    (Object.keys(en) as StringKey[]).map((k) => [k, t(k, lang)]),
  ) as Record<StringKey, string>;
}
