import { fetchPage } from "./fetcher";
import { parseAvailability } from "./parser";
import { currentWeekDates } from "./week";
import { readSnapshot, writeSnapshot, readRecipients, diffSlots } from "./state";
import { sendEmails } from "./notify";

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(run(env));
  },
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function run(env: Env): Promise<void> {
  const startedAt = Date.now();
  let html: string;
  try {
    html = await fetchPage(env.PAGE_URL);
  } catch (e) {
    console.error(JSON.stringify({ event: "fetch_failed", error: e instanceof Error ? e.message : String(e) }));
    return;
  }

  const allSlots = await parseAvailability(html);
  if (allSlots.length === 0) {
    console.error(JSON.stringify({ event: "parse_zero_slots", note: "site format may have changed; not touching KV" }));
    return;
  }
  const week = new Set(currentWeekDates(new Date()));
  const weekSlots = allSlots.filter((s) => week.has(s.date));
  console.log(JSON.stringify({ event: "parsed", parsed: allSlots.length, weekSlots: weekSlots.length }));

  const previous = await readSnapshot(env.KV);
  const newlyAvailable = diffSlots(weekSlots, previous);
  console.log(JSON.stringify({ event: "diffed", previous: previous.length, newly: newlyAvailable.length }));

  if (newlyAvailable.length === 0) {
    await writeSnapshot(env.KV, weekSlots);
    console.log(JSON.stringify({ event: "done", durationMs: Date.now() - startedAt, notified: false }));
    return;
  }

  const recipients = await readRecipients(env.KV);
  if (recipients.length === 0) {
    console.error(JSON.stringify({ event: "no_recipients", note: "skipping email; writing snapshot anyway" }));
    await writeSnapshot(env.KV, weekSlots);
    return;
  }

  const results = await sendEmails(newlyAvailable, recipients, {
    EMAIL: env.EMAIL,
    SENDER_EMAIL: env.SENDER_EMAIL,
    PAGE_URL: env.PAGE_URL,
  });
  for (const r of results) {
    if (r.ok) console.log(JSON.stringify({ event: "sent", recipient: r.recipient }));
    else console.error(JSON.stringify({ event: "send_failed", recipient: r.recipient, error: r.error }));
  }

  const allFailed = results.every((r) => !r.ok);
  if (allFailed) {
    console.error(JSON.stringify({ event: "all_sends_failed", note: "not writing snapshot, will retry next tick" }));
    return;
  }
  await writeSnapshot(env.KV, weekSlots);
  console.log(JSON.stringify({ event: "done", durationMs: Date.now() - startedAt, notified: true }));
}
