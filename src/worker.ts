import { fetchPage } from "./fetcher";
import { parseAvailability, type Slot } from "./parser";
import {
  readWatched, writeWatched, addWatchedDate, removeWatchedDate,
  readRecipients, diffSlots, slotsToStored,
  type WatchedDate,
} from "./state";
import { sendInitialEmail, sendNewSlotsEmail, sendOccupancyEmail, sendExpiryEmail, sendManualStopEmail, sendDailyReportEmail } from "./notify";
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
  const now = new Date(event.scheduledTime);

  const list = await readWatched(env.KV);
  if (list.length === 0) {
    console.log(JSON.stringify({ event: "scheduled_noop", reason: "no_watched_dates" }));
    return;
  }

  const expired = list.filter((w) => isWatchExpired(w.date, now));
  const active = list.filter((w) => !isWatchExpired(w.date, now));

  const recipients = await readRecipients(env.KV);

  // Send expiry emails for any dates that have passed 07:00.
  for (const w of expired) {
    if (recipients.length > 0) {
      const results = await sendExpiryEmail(w.date, recipients, env);
      for (const r of results) {
        if (r.ok) console.log(JSON.stringify({ event: "expiry_email_sent", date: w.date, recipient: r.recipient }));
        else console.error(JSON.stringify({ event: "expiry_email_failed", date: w.date, recipient: r.recipient, error: r.error }));
      }
    }
    console.log(JSON.stringify({ event: "watched_expired", date: w.date }));
  }

  // Nothing more to do if no active watches remain.
  if (active.length === 0) {
    await writeWatched(env.KV, []);
    console.log(JSON.stringify({ event: "done", durationMs: Date.now() - start, active: 0, expired: expired.length }));
    return;
  }

  // One fetch + parse covers every watched date.
  let html: string;
  try {
    html = await fetchPage(env.PAGE_URL);
  } catch (e) {
    console.error(JSON.stringify({ event: "fetch_failed", error: e instanceof Error ? e.message : String(e) }));
    // Persist removal of expired entries even if fetch fails.
    if (expired.length > 0) await writeWatched(env.KV, active);
    return;
  }

  let allSlots: Slot[];
  try {
    allSlots = await parseAvailability(html);
  } catch (e) {
    console.error(JSON.stringify({ event: "parse_failed", error: e instanceof Error ? e.message : String(e) }));
    if (expired.length > 0) await writeWatched(env.KV, active);
    return;
  }
  if (allSlots.length === 0) {
    console.error(JSON.stringify({ event: "parse_zero_slots", note: "site format may have changed; not touching watched state" }));
    if (expired.length > 0) await writeWatched(env.KV, active);
    return;
  }

  const isHourly = now.getUTCMinutes() === 0;
  const isDaily = isDailyReportTick(now);

  const updated: WatchedDate[] = [];
  for (const w of active) {
    const dateSlots = allSlots.filter((s) => s.date === w.date);
    console.log(JSON.stringify({ event: "parsed", date: w.date, slots: dateSlots.length, isHourly }));

    // ── Daily report at 19:00 Bucharest ─────────────────────────────────────
    let dailySendFailed = false;
    let dailyDidSend = false;
    if (isDaily && recipients.length > 0) {
      const seen = new Set(dateSlots.map((s) => `${s.calId}:${s.date}`));
      const booked = w.snapDaily.filter((s) => !seen.has(`${s.calId}:${s.date}`));
      const added = diffSlots(dateSlots, w.snapDaily);
      const isFirst = w.snapDaily.length === 0;
      const results = await sendDailyReportEmail(w.date, added, booked, dateSlots, isFirst, recipients, env);
      for (const r of results) {
        if (r.ok) console.log(JSON.stringify({ event: "daily_report_sent", date: w.date, recipient: r.recipient }));
        else console.error(JSON.stringify({ event: "daily_report_failed", date: w.date, recipient: r.recipient, error: r.error }));
      }
      dailySendFailed = results.every((r) => !r.ok);
      dailyDidSend = true;
    }

    // ── 15-min edge diff: notify if new slots appeared ──────────────────────
    const newSlots = diffSlots(dateSlots, w.snap15);
    let newSlotSendFailed = false;
    if (newSlots.length > 0 && recipients.length > 0) {
      const results = await sendNewSlotsEmail(w.date, newSlots, recipients, env);
      for (const r of results) {
        if (r.ok) console.log(JSON.stringify({ event: "new_slots_sent", date: w.date, recipient: r.recipient }));
        else console.error(JSON.stringify({ event: "new_slots_send_failed", date: w.date, recipient: r.recipient, error: r.error }));
      }
      newSlotSendFailed = results.every((r) => !r.ok);
    }

    // ── Hourly: notify if slot count decreased ──────────────────────────────
    let occupancySendFailed = false;
    if (isHourly && dateSlots.length < w.countHourly && recipients.length > 0) {
      const taken = w.countHourly - dateSlots.length;
      const results = await sendOccupancyEmail(w.date, dateSlots.length, taken, recipients, env);
      for (const r of results) {
        if (r.ok) console.log(JSON.stringify({ event: "occupancy_sent", date: w.date, recipient: r.recipient }));
        else console.error(JSON.stringify({ event: "occupancy_send_failed", date: w.date, recipient: r.recipient, error: r.error }));
      }
      occupancySendFailed = results.every((r) => !r.ok);
    }

    // Per-date at-least-once retention.
    const newSnap15 = (newSlots.length > 0 && newSlotSendFailed) ? w.snap15 : slotsToStored(dateSlots);
    const newCountHourly = isHourly ? (occupancySendFailed ? w.countHourly : dateSlots.length) : w.countHourly;
    const newSnapDaily = (dailyDidSend && !dailySendFailed) ? dateSlots : w.snapDaily;

    updated.push({
      date: w.date,
      snap15: newSnap15,
      countHourly: newCountHourly,
      snapDaily: newSnapDaily,
    });
  }

  await writeWatched(env.KV, updated);
  console.log(JSON.stringify({ event: "done", durationMs: Date.now() - start, active: updated.length, expired: expired.length }));
}

// ── HTTP handler (web UI) ────────────────────────────────────────────────────

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = env.SECRET_PATH;

  if (url.pathname !== path) {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method === "GET") {
    const list = await readWatched(env.KV);
    return new Response(renderWatchPage(list, path), {
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
    const date = (formData.get("date") as string | null) ?? "";

    if (action === "stop") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(renderErrorPage("Data introdusă este invalidă.", path), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      const removed = await removeWatchedDate(env.KV, date);
      if (removed) {
        const recipients = await readRecipients(env.KV);
        if (recipients.length > 0) {
          const results = await sendManualStopEmail(date, recipients, env);
          for (const r of results) {
            if (r.ok) console.log(JSON.stringify({ event: "manual_stop_email_sent", date, recipient: r.recipient }));
            else console.error(JSON.stringify({ event: "manual_stop_email_failed", date, recipient: r.recipient, error: r.error }));
          }
        }
        console.log(JSON.stringify({ event: "watch_stopped", date }));
        return new Response(renderConfirmPage(`Urmărire oprită pentru ${date}.`, path), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(renderConfirmPage(`Data ${date} nu era urmărită.`, path), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (action === "watch") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(renderErrorPage("Data introdusă este invalidă.", path), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Idempotent: if already watched, do nothing (no duplicate initial email).
      const existing = await readWatched(env.KV);
      if (existing.some((w) => w.date === date)) {
        return new Response(renderConfirmPage(`Data ${date} este deja urmărită.`, path), {
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
          if (r.ok) console.log(JSON.stringify({ event: "initial_email_sent", date, recipient: r.recipient }));
          else console.error(JSON.stringify({ event: "initial_email_failed", date, recipient: r.recipient, error: r.error }));
        }
        if (results.every((r) => !r.ok)) {
          return new Response(renderErrorPage("Eroare la trimiterea emailului. Încearcă din nou.", path), {
            status: 502,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      await addWatchedDate(env.KV, {
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

function isDailyReportTick(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return parseInt(p.hour, 10) === 19 && parseInt(p.minute, 10) === 0;
}
