#!/usr/bin/env tsx
/**
 * Manual test for the sent.dm operator-notification channel.
 *
 * Usage:
 *   tsx scripts/notify-owner-test.ts "your message here"
 *   tsx scripts/notify-owner-test.ts                      # uses default
 *
 * Requires in shell env (or .env.production):
 *   SENT_API_KEY
 *   OWNER_PHONE_E164          (e.g. +14078195809)
 *   SENT_DM_OPS_TEMPLATE_ID   (UUID of the ops_alert template)
 *
 * The script first runs in sandbox mode (validates the call shape
 * without buzzing your phone), prints the result, then asks before
 * sending for real. Pass --send to skip the prompt and send live
 * (useful from CI / cron / hooks).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { notifyOwner } from "../lib/sentdm";

// Lazily source .env.production if it exists — most operator workflows
// run via tsx with the prod env pulled. Skip silently if absent.
const envPath = path.resolve(__dirname, "..", ".env.production");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sendFlag = args.includes("--send");
  const message = args.filter((a) => !a.startsWith("--")).join(" ") ||
    "Test ping from notify-owner-test.ts — if you got this, the channel works.";

  console.log(`Recipient:  ${process.env.OWNER_PHONE_E164 ?? "(unset)"}`);
  console.log(`API key:    ${process.env.SENT_API_KEY ? "set" : "(unset)"}`);
  console.log(`Template:   ${process.env.SENT_DM_OPS_TEMPLATE_ID ?? "(unset)"}`);
  console.log(`Message:    "${message}"\n`);

  // Sandbox round-trip first — verifies the API call shape without
  // actually buzzing the phone or spending credits.
  console.log("→ Sandbox dry-run...");
  const dry = await notifyOwner(message, { tag: "test", sandbox: true });
  console.log("  ", dry);

  if (dry.reason === "not_configured") {
    console.error("\nMissing env vars — see script header.");
    process.exit(1);
  }

  if (!sendFlag) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const confirm = await new Promise<string>((resolve) =>
      rl.question("\nSend live? (y/N): ", resolve),
    );
    rl.close();
    if (!/^y(es)?$/i.test(confirm.trim())) {
      console.log("Skipped.");
      process.exit(0);
    }
  }

  console.log("\n→ Sending live...");
  const live = await notifyOwner(message, {
    tag: "test",
    idempotencyKey: `test-${Date.now()}`,
  });
  console.log("  ", live);
  if (!live.sent) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
