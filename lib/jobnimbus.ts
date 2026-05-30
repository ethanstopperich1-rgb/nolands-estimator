/**
 * JobNimbus API client — TypeScript port of Sydney's Python client.
 *
 * Why this exists alongside voxaris-pitch/agents/sydney/jobnimbus.py:
 *   - Sydney's client writes to JobNimbus AFTER she's spoken with the
 *     homeowner (book_inspection, log_lead).
 *   - This TS client writes to JobNimbus IMMEDIATELY when the customer
 *     submits the estimator + the painted-roof V3 pipeline completes —
 *     well before Sydney is involved.
 *   - Without this, every customer who fills out the estimator but
 *     doesn't speak with Sydney is invisible to Noland's reps in
 *     JobNimbus. And when Sydney later calls them, she creates a
 *     duplicate contact because she has no foreign key to look up.
 *
 * The two clients MUST stay aligned on:
 *   - API base URL (https://app.jobnimbus.com/api1 — JobNimbus REST v1)
 *   - Auth model (Bearer token)
 *   - Resource shapes (contacts, jobs, notes)
 *
 * Soft-fail behavior (mirrors Sydney's python client):
 *   - When JOBNIMBUS_API_KEY is unset, every function returns
 *     { ok: false, reason: "not_configured" }
 *   - When a request fails (network, 4xx, 5xx), returns
 *     { ok: false, reason: "error", error: "..." } — caller decides
 *     whether to fall back, retry, or skip.
 *   - NEVER throws — JobNimbus being down must not break the customer's
 *     painted-roof response.
 *
 * Reference: https://documentation.jobnimbus.com
 *
 * Resources used:
 *   - GET  /contacts?display_name=...  search contacts (dedup before create)
 *   - POST /contacts                    create homeowner contact
 *   - POST /jobs                        create inspection job for that contact
 *   - POST /tasks                       attach a note/follow-up to the contact
 */

const BASE_URL = process.env.JOBNIMBUS_BASE_URL ?? "https://app.jobnimbus.com/api1";
const TIMEOUT_MS = 5000;

export interface JobNimbusError {
  ok: false;
  reason: "not_configured" | "error" | "not_found";
  error?: string;
  /** HTTP status when reason === "error". */
  status?: number;
}

export interface CreateContactInput {
  /** Full name. JobNimbus splits this into first_name / last_name on their side. */
  displayName: string;
  /** E.164 preferred but any valid US format accepted. */
  phone?: string;
  email?: string;
  /** Street address line 1. JN parses for city/state if those aren't passed. */
  address?: string;
  /** US 5-digit ZIP. Populates JN's dedicated `zip` column so reps can
   *  filter the contacts list + dashboards by city without parsing the
   *  address string. */
  zip?: string;
  /** City (when known from Google Places autocomplete). Sets JN's `city`
   *  column directly so reports can group by city. */
  city?: string;
  /** US state postal abbreviation (FL, GA, etc.). Sets JN's `state_text`. */
  state?: string;
  /** Office/location attribution. JobNimbus uses "tags" for office routing. */
  tags?: string[];
  /** TCPA voice-consent state captured at form-submit time. Surfaces as
   *  a tag (`voice-consent-yes` | `voice-consent-no`) so reps know
   *  whether Sarah's been dispatched or whether they need to call. */
  voiceConsent?: boolean;
  /** Homeowner's preferred language ("en" | "es"). Surfaces as a tag
   *  (`lang-en` | `lang-es`) so the rep knows whether to send a
   *  bilingual rep / Spanish-speaker to the inspection. */
  language?: "en" | "es";
}

export interface JNContact {
  ok: true;
  jnid: string;
  displayName: string;
}

export interface CreateJobInput {
  contactId: string;
  /** Human-readable job name. e.g. "Roof Inspection — 8450 Oak Park Ave" */
  displayName: string;
  /** Free-form description. Painted roof URL + estimate range goes here. */
  description?: string;
  /** ISO-8601 date string for scheduled inspection. Omit for "unscheduled". */
  dateStart?: string;
  /** Record type / job category. Noland's JN vocabulary observed in their
   *  live data: "Retail" (81%) / "Insurance" (15%) / "New Construction"
   *  (4%). Estimator-created jobs default to "Retail" (residential
   *  walk-in inspection). NEVER use "Estimate" — that's not a real
   *  record_type in Noland's taxonomy and lands the job in a dead bucket. */
  recordType?: "Retail" | "Insurance" | "New Construction";
  status?: string;
}

export interface JNJob {
  ok: true;
  jnid: string;
}

export interface JNJobSummary {
  jnid: string;
  /** UNIX seconds — convert to ms for JS Date. */
  dateStart: number | null;
  /** Primary contact jnid (matches leads.jobnimbus_contact_id). */
  primaryContactId: string | null;
  displayName: string;
  statusName: string | null;
}

export interface SearchJobsResult {
  ok: true;
  jobs: JNJobSummary[];
}

/**
 * Search JobNimbus jobs whose date_start falls in [startUnix, endUnix].
 * Used by /api/cron/podium-reminders to discover newly-booked
 * appointments and cache them on the leads row for the reminder cron.
 *
 * JobNimbus's filter param is Elasticsearch DSL — see the Sydney
 * Python client (voxaris-pitch/agents/sydney/jobnimbus.py) for the
 * canonical filter shape this mirrors.
 */
export async function searchJobsByDateRange(
  startUnix: number,
  endUnix: number,
  limit = 200,
): Promise<SearchJobsResult | JobNimbusError> {
  if (!jobNimbusConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const url = new URL(`${BASE_URL}/jobs`);
    url.searchParams.set(
      "filter",
      JSON.stringify({
        must: [{ range: { date_start: { gte: startUnix, lte: endUnix } } }],
      }),
    );
    url.searchParams.set("size", String(limit));
    const res = await jnFetch(url.toString(), { method: "GET" });
    if (!res.ok) return res;
    const raw = res.json as
      | { results?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>;
    const rows: Array<Record<string, unknown>> = Array.isArray(raw)
      ? raw
      : raw.results ?? raw.data ?? [];
    const jobs: JNJobSummary[] = rows.map((row) => {
      const primary = row.primary as { id?: string } | undefined;
      return {
        jnid: String(row.jnid ?? ""),
        dateStart:
          typeof row.date_start === "number" && Number.isFinite(row.date_start)
            ? (row.date_start as number)
            : null,
        primaryContactId: primary?.id ? String(primary.id) : null,
        displayName: String(row.display_name ?? ""),
        statusName: row.status_name ? String(row.status_name) : null,
      };
    });
    return { ok: true, jobs };
  } catch (err) {
    return jnUnexpected(err);
  }
}

export interface AttachNoteInput {
  contactId: string;
  /** Note body. The painted-roof URL + share-link + estimate range live here. */
  body: string;
}

export interface JNNote {
  ok: true;
  jnid: string;
}

/**
 * Feature-flag check — lets routes skip the JobNimbus call entirely
 * (and the import) when the env isn't wired.
 */
export function jobNimbusConfigured(): boolean {
  return Boolean(process.env.JOBNIMBUS_API_KEY);
}

/**
 * Search for an existing contact by phone number. JobNimbus's contacts
 * endpoint supports a `display_name` filter; for phone-based dedup
 * we use the `mobile_phone` field via the `filter` query param.
 *
 * Returns the first match. Mirrors the dedup behavior Sydney's
 * book_inspection uses to avoid double-creating contacts.
 */
export async function findContactByPhone(
  phone: string,
): Promise<JNContact | JobNimbusError> {
  if (!jobNimbusConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const url = new URL(`${BASE_URL}/contacts`);
    // Strip non-digits for the search; JobNimbus stores normalized.
    const digits = phone.replace(/\D/g, "");
    url.searchParams.set(
      "filter",
      JSON.stringify({
        must: [{ term: { mobile_phone: digits } }],
      }),
    );
    const res = await jnFetch(url.toString(), { method: "GET" });
    if (!res.ok) return res;
    const data = res.json as { count?: number; results?: Array<{ jnid: string; display_name: string }> };
    const first = data.results?.[0];
    if (!first) return { ok: false, reason: "not_found" };
    return { ok: true, jnid: first.jnid, displayName: first.display_name };
  } catch (err) {
    return jnUnexpected(err);
  }
}

/**
 * Create a new contact. Returns the new jnid for downstream resource
 * creation (jobs, notes).
 */
export async function createContact(
  input: CreateContactInput,
): Promise<JNContact | JobNimbusError> {
  if (!jobNimbusConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const [first, ...rest] = input.displayName.trim().split(/\s+/);
    const last = rest.join(" ");
    // Schema discovered May 2026 from Noland's live JN data:
    //   record_type_name on contacts → "Homeowner" (95%) / Subcontractor /
    //     Business. Sarah only ever creates homeowners.
    //   status_name → "New" (92%) / "Active" (8%). Estimator-sourced
    //     contacts are brand-new leads.
    //   source_name → free-form string, Noland's existing taxonomy uses
    //     "Web Site / SEO - Internet Organic", "Self Generated Lead -
    //     Salesmen", "Paid Digital Ads - Google Ads", etc. Default the
    //     estimator source to the web bucket so Noland's dashboards
    //     attribute Voxaris leads correctly; env-override available.
    //   sales_rep_name DELIBERATELY OMITTED — Noland's reps own this
    //     field. Writing "Estimator" or "Sydney (clermont)" corrupts
    //     their assignment workflow. Office assigns manually after
    //     the contact lands. Set JOBNIMBUS_SALES_REP_NAME to force a
    //     value only if a specific office requested it.
    // Tag set: caller-supplied tags + auto-tags from voiceConsent + language.
    // Tags are JN's canonical free-text taxonomy — reps filter the contact
    // list by them, so embedding rep-actionable state here means they
    // don't have to open the contact + scroll to find it.
    const autoTags: string[] = [];
    if (input.voiceConsent === true) autoTags.push("voice-consent-yes");
    if (input.voiceConsent === false) autoTags.push("voice-consent-no");
    if (input.language === "es") autoTags.push("lang-es");
    if (input.language === "en") autoTags.push("lang-en");

    const body: Record<string, unknown> = {
      display_name: input.displayName,
      first_name: first || "",
      last_name: last || "",
      mobile_phone: input.phone ?? "",
      email: input.email ?? "",
      address_line1: input.address ?? "",
      // JN has dedicated columns for city / state_text / zip — populate
      // them when we have the data instead of relying on JN's loose
      // address-string parsing. Enables city-level filtering and the
      // /api/social-proof/jobs-by-zip query (which is keyed on `zip`).
      city: input.city ?? "",
      state_text: input.state ?? "",
      zip: input.zip ?? "",
      tags: [...(input.tags ?? []), ...autoTags],
      record_type_name: "Homeowner",
      status_name: "New",
      // Default source: "Voxaris Estimator" — gives Destiny + team a
      // clean attribution bucket in JN reporting so they can ROI-track
      // estimator leads vs AIM / Angie / Google Ads side-by-side.
      // Free-form string; JN accepts any source_name and groups records
      // by exact match in their dashboards. Override via env if the
      // contractor wants to map us into their existing taxonomy.
      source_name: process.env.JOBNIMBUS_SOURCE_NAME ?? "Voxaris Estimator",
    };
    if (process.env.JOBNIMBUS_SALES_REP_NAME) {
      body.sales_rep_name = process.env.JOBNIMBUS_SALES_REP_NAME;
    }
    // Notify the intake team on every new estimator lead. JN routes
    // the contact to each listed user's dashboard + sends in-app
    // notifications. IDs are env-driven so swapping personnel never
    // needs a code push. Comma-separated JN user IDs (m7qb…/8-hex).
    //
    // Locked May 2026 for Noland's: Destiny Jones, Steven Olesen,
    // Savannah Huffman, Myiah Ragone.
    const ownerIdsRaw = process.env.JOBNIMBUS_NEW_LEAD_OWNER_IDS || "";
    const ownerIds = ownerIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ownerIds.length > 0) {
      body.owners = ownerIds.map((id) => ({ id }));
    }
    const res = await jnFetch(`${BASE_URL}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const data = res.json as { jnid?: string; display_name?: string };
    if (!data.jnid) {
      return { ok: false, reason: "error", error: "no_jnid_in_response" };
    }
    return { ok: true, jnid: data.jnid, displayName: data.display_name ?? input.displayName };
  } catch (err) {
    return jnUnexpected(err);
  }
}

/**
 * Create a job (inspection / estimate) for an existing contact. The
 * painted-roof + estimate-range get stitched into the description so
 * Noland's reps see the full context in the JobNimbus job detail view.
 */
export async function createInspectionJob(
  input: CreateJobInput,
): Promise<JNJob | JobNimbusError> {
  if (!jobNimbusConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    // Noland's job record_type_name vocabulary: "Retail" (81%) /
    // "Insurance" (15%) / "New Construction" (4%). Estimator-created
    // jobs default to "Retail" (residential walk-in inspection) unless
    // the caller flags a storm event → "Insurance". status_name "Lead"
    // matches their pipeline entry point.
    const body = {
      primary: { id: input.contactId },
      // JN Jobs require `name` (Contacts use `display_name`). Sending
      // display_name here 400s: "Missing required field(s): name".
      name: input.displayName,
      description: input.description ?? "",
      date_start: input.dateStart
        ? Math.floor(new Date(input.dateStart).getTime() / 1000)
        : undefined,
      record_type_name: input.recordType ?? "Retail",
      status_name: input.status ?? "Lead",
    };
    const res = await jnFetch(`${BASE_URL}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const data = res.json as { jnid?: string };
    if (!data.jnid) {
      return { ok: false, reason: "error", error: "no_jnid_in_response" };
    }
    return { ok: true, jnid: data.jnid };
  } catch (err) {
    return jnUnexpected(err);
  }
}

export interface CreateMeasureCallTaskInput {
  /** The JN contact this task is bound to. */
  contactId: string;
  /** Convention: "Measure Call-{address}-{name}" so the rep recognizes
   *  the entry in their calendar feed at a glance. */
  title: string;
  /** Task start time, ISO 8601 with timezone offset. */
  dateStartIso: string;
  /** Window length in minutes. Defaults to 60 (Noland's typical
   *  Measure Call window). */
  durationMinutes?: number;
  /** Free-form description shown when the rep opens the task. Customer
   *  call summary + caller contact info lands here. */
  description?: string;
  /** JN user_id of the field rep this task is assigned to. Omit for
   *  the unrouted queue (dispatcher routes manually). */
  ownerId?: string;
  /** Defaults to "Measure Call" (Noland's standard residential measure
   *  task). Override to "Self Gen-Measure Call" for canvass leads. */
  recordType?: string;
}

export interface JNTask {
  ok: true;
  jnid: string;
}

/**
 * Create a Measure Call task on Noland's JobNimbus calendar.
 *
 * Mirrors the Python client at voxaris-pitch/agents/sydney/jobnimbus.py
 * `create_measure_call_task` (Sarah's voice agent uses the same shape).
 * Both clients writing the same task type means SMS-booked + voice-
 * booked appointments look identical on the rep's calendar.
 *
 * Schema notes (probed live, May 2026):
 *   - JN's /tasks POST returns the created task with jnid.
 *   - date_end is computed as date_start + duration_minutes (JN
 *     accepts either explicit date_end or this implicit form; we
 *     send both for safety).
 *   - hide_from_calendarview=false is the default — task SHOWS on the
 *     rep's calendar feed (the whole point of using tasks instead of
 *     jobs for scheduling).
 *   - owners: optional. When unset, the task lands in the office's
 *     unrouted queue. The Noland's dispatcher routes manually.
 */
export async function createMeasureCallTask(
  input: CreateMeasureCallTaskInput,
): Promise<JNTask | JobNimbusError> {
  if (!jobNimbusConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const startUnix = Math.floor(new Date(input.dateStartIso).getTime() / 1000);
    if (!Number.isFinite(startUnix)) {
      return { ok: false, reason: "error", error: "invalid_dateStartIso" };
    }
    const durationMinutes = input.durationMinutes ?? 60;
    const endUnix = startUnix + durationMinutes * 60;
    const body: Record<string, unknown> = {
      primary: { id: input.contactId },
      title: input.title,
      description: input.description ?? "",
      date_start: startUnix,
      date_end: endUnix,
      record_type_name: input.recordType ?? "Measure Call",
      hide_from_calendarview: false,
    };
    if (input.ownerId) {
      body.owners = [{ id: input.ownerId }];
    }
    const res = await jnFetch(`${BASE_URL}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const data = res.json as { jnid?: string };
    if (!data.jnid) {
      return { ok: false, reason: "error", error: "no_jnid_in_response" };
    }
    return { ok: true, jnid: data.jnid };
  } catch (err) {
    return jnUnexpected(err);
  }
}

/**
 * Attach a note to a contact. Used to log "painted roof report
 * generated at {url}, estimate range $X-$Y/mo".
 */
export async function attachNote(
  input: AttachNoteInput,
): Promise<JNNote | JobNimbusError> {
  if (!jobNimbusConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const body = {
      primary: { id: input.contactId },
      note: input.body,
      record_type_name: "Note",
    };
    // Notes are JN *activities*, not tasks. POSTing to /tasks 400s:
    // "Invalid record_type_name - Note".
    const res = await jnFetch(`${BASE_URL}/activities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const data = res.json as { jnid?: string };
    if (!data.jnid) {
      return { ok: false, reason: "error", error: "no_jnid_in_response" };
    }
    return { ok: true, jnid: data.jnid };
  } catch (err) {
    return jnUnexpected(err);
  }
}

// ─── Internals ────────────────────────────────────────────────────────

type JNFetchResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: "error"; status: number; error: string };

async function jnFetch(url: string, init: RequestInit): Promise<JNFetchResult> {
  const apiKey = process.env.JOBNIMBUS_API_KEY!;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        status: res.status,
        error: text.slice(0, 200),
      };
    }
    const json = await res.json().catch(() => ({}));
    return { ok: true, json };
  } finally {
    clearTimeout(timer);
  }
}

function jnUnexpected(err: unknown): JobNimbusError {
  return {
    ok: false,
    reason: "error",
    error: err instanceof Error ? err.message : String(err),
  };
}
