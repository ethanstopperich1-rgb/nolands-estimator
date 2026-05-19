/**
 * One-off test-SMS sender.
 *
 * Usage:
 *   1. Make sure Twilio creds are in Vercel:
 *        vercel env add TWILIO_ACCOUNT_SID production
 *        vercel env add TWILIO_AUTH_TOKEN production
 *        vercel env add TWILIO_PHONE_NUMBER production
 *   2. Pull them locally:
 *        vercel env pull .env.local
 *   3. Run:
 *        npx tsx scripts/send-test-sms.ts +14078195809
 *
 * The script calls our actual `lib/twilio.ts:sendSms` helper — so a
 * successful send here proves the exact code path /api/leads uses in
 * production works end-to-end.
 */

import { config } from "dotenv";
import { sendSms, toE164, twilioConfigured } from "../lib/twilio";

config({ path: ".env.local" });

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npx tsx scripts/send-test-sms.ts +1XXXXXXXXXX");
    process.exit(2);
  }
  const e164 = toE164(target);
  if (!e164) {
    console.error(`ERROR: '${target}' is not a parseable phone number.`);
    process.exit(2);
  }
  if (!twilioConfigured()) {
    console.error(
      "ERROR: Twilio not configured. Missing one of: " +
        "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.",
    );
    console.error("Run: vercel env pull .env.local");
    process.exit(1);
  }

  const body =
    "Voxaris test SMS — if you got this, the +1 888 786 9134 → app " +
    "→ Twilio loop is working. Reply YES to test the Sydney callback " +
    "flow (only works if you have a lead in the DB on this number).";

  console.log(`→ Sending to ${e164}...`);
  try {
    const result = await sendSms({
      to: e164,
      body,
      // Skip the opt-out gate since this is a self-test to a number
      // we control. NEVER use skipOptOutCheck for consumer messaging.
      skipOptOutCheck: true,
    });
    console.log("✓ Sent");
    console.log("  sid:    ", result.sid);
    console.log("  status: ", result.status);
    console.log("  to:     ", result.to);
  } catch (err) {
    console.error("✗ Send failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
