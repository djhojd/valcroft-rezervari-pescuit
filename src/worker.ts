import { fetchPage } from "./fetcher";
import { parseAvailability } from "./parser";
import { currentWeekDates } from "./week";
import { readSnapshot, writeSnapshot, readRecipients, diffSlots } from "./state";
import { sendEmails } from "./notify";

export type Env = {
  KV: KVNamespace;
  EMAIL: SendEmail;
  PAGE_URL: string;
  SENDER_EMAIL: string;
};

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
};

async function run(env: Env): Promise<void> {
  const startedAt = Date.now();
  let html: string;
  try {
    html = await fetchPage(env.PAGE_URL);
  } catch (e) {
    console.error("fetch failed:", e);
    return;
  }

  const allSlots = await parseAvailability(html);
  if (allSlots.length === 0) {
    console.error("parse yielded zero slots — site format may have changed; not touching KV");
    return;
  }
  const week = new Set(currentWeekDates(new Date()));
  const weekSlots = allSlots.filter((s) => week.has(s.date));
  console.log(`parsed=${allSlots.length} weekSlots=${weekSlots.length}`);

  const previous = await readSnapshot(env.KV);
  const newlyAvailable = diffSlots(weekSlots, previous);
  console.log(`previous=${previous.length} newly=${newlyAvailable.length}`);

  if (newlyAvailable.length === 0) {
    await writeSnapshot(env.KV, weekSlots);
    console.log(`done in ${Date.now() - startedAt}ms (no notification)`);
    return;
  }

  const recipients = await readRecipients(env.KV);
  if (recipients.length === 0) {
    console.error("no recipients in KV — skipping email; writing snapshot anyway");
    await writeSnapshot(env.KV, weekSlots);
    return;
  }

  const results = await sendEmails(newlyAvailable, recipients, {
    EMAIL: env.EMAIL,
    SENDER_EMAIL: env.SENDER_EMAIL,
    PAGE_URL: env.PAGE_URL,
  });
  for (const r of results) {
    if (r.ok) console.log(`sent: ${r.recipient}`);
    else console.error(`send failed: ${r.recipient}: ${r.error}`);
  }

  const allFailed = results.every((r) => !r.ok);
  if (allFailed) {
    console.error("all sends failed — not writing snapshot, will retry next tick");
    return;
  }
  await writeSnapshot(env.KV, weekSlots);
  console.log(`done in ${Date.now() - startedAt}ms (notified)`);
}
