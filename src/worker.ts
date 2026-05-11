import { fetchPage } from "./fetcher";
import { parseAvailability, type Slot } from "./parser";
import { readWatched, writeWatched, clearWatched, readRecipients, diffSlots, slotsToStored } from "./state";
import { sendInitialEmail, sendNewSlotsEmail, sendOccupancyEmail, sendExpiryEmail, sendManualStopEmail } from "./notify";
import { renderWatchPage, renderConfirmPage, renderErrorPage } from "./ui";

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(event, env));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
} satisfies ExportedHandler<Env>;

// ── Scheduled handler ────────────────────────────────────────────────────────

async function runScheduled(event: ScheduledController, env: Env): Promise<void> {
  const start = Date.now();

  const watched = await readWatched(env.KV);
  if (!watched) {
    console.log(JSON.stringify({ event: "scheduled_noop", reason: "no_watched_date" }));
    return;
  }

  // Auto-expire: stop watching once 07:00 Bucharest time on the watched date has passed
  // (last cancellation window closes at 07:00 that morning).
  if (isWatchExpired(watched.date, new Date(event.scheduledTime))) {
    const recipients = await readRecipients(env.KV);
    if (recipients.length > 0) {
      const results = await sendExpiryEmail(watched.date, recipients, env);
      for (const r of results) {
        if (r.ok) console.log(JSON.stringify({ event: "expiry_email_sent", recipient: r.recipient }));
        else console.error(JSON.stringify({ event: "expiry_email_failed", recipient: r.recipient, error: r.error }));
      }
    }
    await clearWatched(env.KV);
    console.log(JSON.stringify({ event: "watched_expired", date: watched.date }));
    return;
  }

  let html: string;
  try {
    html = await fetchPage(env.PAGE_URL);
  } catch (e) {
    console.error(JSON.stringify({ event: "fetch_failed", error: e instanceof Error ? e.message : String(e) }));
    return;
  }

  let allSlots: Slot[];
  try {
    allSlots = await parseAvailability(html);
  } catch (e) {
    console.error(JSON.stringify({ event: "parse_failed", error: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (allSlots.length === 0) {
    console.error(JSON.stringify({ event: "parse_zero_slots", note: "site format may have changed; not touching KV" }));
    return;
  }

  const dateSlots = allSlots.filter((s) => s.date === watched.date);
  const recipients = await readRecipients(env.KV);
  const isHourly = new Date(event.scheduledTime).getUTCMinutes() === 0;

  console.log(JSON.stringify({ event: "parsed", date: watched.date, slots: dateSlots.length, isHourly }));

  // ── 15-min edge diff: notify if new slots appeared ────────────────────────
  const newSlots = diffSlots(dateSlots, watched.snap15);
  let newSlotSendFailed = false;
  if (newSlots.length > 0 && recipients.length > 0) {
    const results = await sendNewSlotsEmail(watched.date, newSlots, recipients, env);
    for (const r of results) {
      if (r.ok) console.log(JSON.stringify({ event: "new_slots_sent", recipient: r.recipient }));
      else console.error(JSON.stringify({ event: "new_slots_send_failed", recipient: r.recipient, error: r.error }));
    }
    newSlotSendFailed = results.every((r) => !r.ok);
  }

  // ── Hourly: notify if slot count decreased ────────────────────────────────
  let occupancySendFailed = false;
  if (isHourly && dateSlots.length < watched.countHourly && recipients.length > 0) {
    const taken = watched.countHourly - dateSlots.length;
    const results = await sendOccupancyEmail(watched.date, dateSlots.length, taken, recipients, env);
    for (const r of results) {
      if (r.ok) console.log(JSON.stringify({ event: "occupancy_sent", recipient: r.recipient }));
      else console.error(JSON.stringify({ event: "occupancy_send_failed", recipient: r.recipient, error: r.error }));
    }
    occupancySendFailed = results.every((r) => !r.ok);
  }

  // ── Update KV state ───────────────────────────────────────────────────────
  // At-least-once: if new-slot email failed, keep old snap15 so it retries next tick.
  const newSnap15 = (newSlots.length > 0 && newSlotSendFailed)
    ? watched.snap15
    : slotsToStored(dateSlots);

  // Hourly baseline: always reset at :00 unless the occupancy email failed
  // (retry the decrease notification next hour).
  const newCountHourly = isHourly
    ? (occupancySendFailed ? watched.countHourly : dateSlots.length)
    : watched.countHourly;

  await writeWatched(env.KV, {
    date: watched.date,
    snap15: newSnap15,
    countHourly: newCountHourly,
    snapDaily: watched.snapDaily,
  });
  console.log(JSON.stringify({ event: "done", durationMs: Date.now() - start, date: watched.date }));
}

// ── HTTP handler (web UI) ────────────────────────────────────────────────────

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = env.SECRET_PATH;

  if (url.pathname !== path) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method === "GET") {
    const watched = await readWatched(env.KV);
    return new Response(renderWatchPage(watched, path), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (request.method === "POST") {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const action = formData.get("action");

    if (action === "stop") {
      const watched = await readWatched(env.KV);
      if (watched) {
        const recipients = await readRecipients(env.KV);
        if (recipients.length > 0) {
          const results = await sendManualStopEmail(watched.date, recipients, env);
          for (const r of results) {
            if (r.ok) console.log(JSON.stringify({ event: "manual_stop_email_sent", recipient: r.recipient }));
            else console.error(JSON.stringify({ event: "manual_stop_email_failed", recipient: r.recipient, error: r.error }));
          }
        }
      }
      await clearWatched(env.KV);
      console.log(JSON.stringify({ event: "watch_stopped" }));
      return new Response(renderConfirmPage("Urmărire oprită.", path), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (action === "watch") {
      const date = (formData.get("date") as string | null) ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(renderErrorPage("Data introdusă este invalidă.", path), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      let html: string;
      try {
        html = await fetchPage(env.PAGE_URL);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ event: "watch_fetch_failed", error: msg }));
        return new Response(renderErrorPage("Eroare la accesarea site-ului. Încearcă din nou.", path), {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      let allSlots: Slot[];
      try {
        allSlots = await parseAvailability(html);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({ event: "watch_parse_failed", error: msg }));
        return new Response(renderErrorPage("Eroare la procesarea datelor. Încearcă din nou.", path), {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const dateSlots = allSlots.filter((s) => s.date === date);
      const recipients = await readRecipients(env.KV);

      if (recipients.length > 0) {
        const results = await sendInitialEmail(date, dateSlots, 15, recipients, env);
        for (const r of results) {
          if (r.ok) console.log(JSON.stringify({ event: "initial_email_sent", recipient: r.recipient }));
          else console.error(JSON.stringify({ event: "initial_email_failed", recipient: r.recipient, error: r.error }));
        }
        if (results.every((r) => !r.ok)) {
          return new Response(renderErrorPage("Eroare la trimiterea emailului. Încearcă din nou.", path), {
            status: 502,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      await writeWatched(env.KV, {
        date,
        snap15: slotsToStored(dateSlots),
        countHourly: dateSlots.length,
        snapDaily: [],
      });

      const count = dateSlots.length;
      const slotsText = count === 0
        ? "Niciun loc disponibil momentan — vei fi notificat imediat ce apar."
        : `${count} ${count === 1 ? "loc liber" : "locuri libere"} trimis${count === 1 ? "" : "e"} pe email.`;
      console.log(JSON.stringify({ event: "watch_registered", date, slots: count }));
      return new Response(renderConfirmPage(`Urmărire activată pentru ${date}. ${slotsText}`, path), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Bad Request", { status: 400 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function isWatchExpired(watchedDate: string, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const todayStr = `${p.year}-${p.month}-${p.day}`;
  const currentHour = parseInt(p.hour, 10);
  return watchedDate < todayStr || (watchedDate === todayStr && currentHour >= 7);
}
