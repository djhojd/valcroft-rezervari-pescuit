# Multi-Date Watching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the watcher from one date to a list of dates — each added, stopped, and auto-expired independently.

**Architecture:** Single KV key `watched` now stores `WatchedDate[]`. `readWatched` auto-wraps the legacy single-object record into a one-entry array for zero-downtime deploy. The scheduled handler loops over each watched date and reuses the existing single-date logic per entry. UI shows a list with per-date "Oprește" buttons plus an always-visible date picker.

**Tech Stack:** Cloudflare Workers, Workers KV, Email Workers, TypeScript.

**Design doc:** `docs/plans/2026-05-08-multi-date-design.md`.

**Project state (read before starting):**
- `src/state.ts` — current `WatchedState` (single object) + accessors.
- `src/worker.ts` — `runScheduled` and `handleFetch` (UI POST routing). Has `isWatchExpired` and `isDailyReportTick` utilities at the bottom.
- `src/ui.ts` — two-branch `renderWatchPage(watched: WatchedState | null, path)`.
- `src/notify.ts` — five email functions, all taking a single `date: string`. Unchanged by this plan.
- `src/parser.ts` — `Slot = { calId, pontoon, date }`.

**Verification:** `npm run typecheck`. No test framework. Smoke test post-deploy via UI + `wrangler tail`.

---

### Task 1: Rewrite `src/state.ts` for multi-date

**Files:**
- Modify: `src/state.ts` (full file rewrite — easier than incremental edits given the type change cascade)

**What:** Rename `WatchedState` → `WatchedDate`. `readWatched` returns `WatchedDate[]`. Add `addWatchedDate` and `removeWatchedDate`. Delete `clearWatched`. Keep `StoredSlot`, `diffSlots`, `slotsToStored`, `readRecipients` unchanged.

**Step 1: Replace the file contents with:**

```ts
import type { Slot } from "./parser";

export type StoredSlot = { calId: string; date: string };

export type WatchedDate = {
  date: string;         // YYYY-MM-DD (Bucharest local date)
  snap15: StoredSlot[]; // slots at last 15-min tick; basis for edge diff
  countHourly: number;  // slot count at last :00 tick; basis for decrease detection
  snapDaily: Slot[];    // slots at last 19:00 tick; basis for daily report diff
};

function isWatchedDate(x: unknown): x is WatchedDate {
  if (!x || typeof x !== "object") return false;
  const w = x as Record<string, unknown>;
  return typeof w.date === "string"
    && Array.isArray(w.snap15)
    && typeof w.countHourly === "number";
}

function normalize(entry: Partial<WatchedDate> & { date: string; snap15: StoredSlot[]; countHourly: number }): WatchedDate {
  return {
    date: entry.date,
    snap15: entry.snap15,
    countHourly: entry.countHourly,
    snapDaily: Array.isArray(entry.snapDaily) ? entry.snapDaily : [],
  };
}

export async function readWatched(kv: KVNamespace): Promise<WatchedDate[]> {
  try {
    const raw = await kv.get("watched", "json");
    if (Array.isArray(raw)) {
      return raw.filter(isWatchedDate).map((e) => normalize(e));
    }
    if (isWatchedDate(raw)) {
      // Legacy single-object record from the pre-multi-date version. Wrap as a one-entry list.
      return [normalize(raw)];
    }
    return [];
  } catch {
    return [];
  }
}

export async function writeWatched(kv: KVNamespace, list: WatchedDate[]): Promise<void> {
  await kv.put("watched", JSON.stringify(list));
}

export async function addWatchedDate(kv: KVNamespace, entry: WatchedDate): Promise<boolean> {
  const list = await readWatched(kv);
  if (list.some((w) => w.date === entry.date)) return false;
  list.push(entry);
  await writeWatched(kv, list);
  return true;
}

export async function removeWatchedDate(kv: KVNamespace, date: string): Promise<boolean> {
  const list = await readWatched(kv);
  const next = list.filter((w) => w.date !== date);
  if (next.length === list.length) return false;
  await writeWatched(kv, next);
  return true;
}

export async function readRecipients(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get("recipients", "json");
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

export function diffSlots(current: Slot[], previous: StoredSlot[]): Slot[] {
  const seen = new Set(previous.map((s) => `${s.calId}:${s.date}`));
  return current.filter((s) => !seen.has(`${s.calId}:${s.date}`));
}

export function slotsToStored(slots: Slot[]): StoredSlot[] {
  return slots.map((s) => ({ calId: s.calId, date: s.date }));
}
```

**Step 2:** Typecheck will fail (worker.ts and ui.ts still reference the old API). That's expected — fixed in Tasks 2 and 3.

**Step 3: No commit yet.** Wait for Task 3.

---

### Task 2: Rewrite `src/ui.ts` for the list view

**Files:**
- Modify: `src/ui.ts`

**What:** `renderWatchPage` takes `list: WatchedDate[]` and renders a date list with per-date `action=stop` forms, plus a single always-visible date picker. Drop the two-branch (idle vs active) split.

**Step 1: Replace the file contents with:**

```ts
import type { WatchedDate } from "./state";
import { formatDateLong } from "./notify";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function renderWatchPage(list: WatchedDate[], path: string): string {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));

  const watchedSection = sorted.length === 0
    ? `<p>Nicio dată urmărită momentan.</p>`
    : `<p>Date urmărite (verificare la fiecare 15 minute, până la 07:00 în acea zi):</p>
  <ul class="watched-list">
    ${sorted.map((w) => `
      <li>
        <strong>${formatDateLong(w.date)}</strong>
        <form method="POST" action="${path}" style="display:inline">
          <input type="hidden" name="action" value="stop">
          <input type="hidden" name="date" value="${w.date}">
          <button type="submit" style="background:#c0392b;color:#fff;margin-left:.5rem">Oprește</button>
        </form>
      </li>`).join("")}
  </ul>`;

  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Valcroft — Urmărire disponibilitate</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    label { display: block; margin-bottom: .5rem; }
    input[type=date] { font-size: 1rem; padding: .3rem; margin-top: .25rem; }
    button { padding: .4rem 1rem; font-size: 1rem; cursor: pointer; }
    .watched-list { list-style: none; padding: 0; }
    .watched-list li { padding: .4rem 0; border-bottom: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>Valcroft — Urmărire disponibilitate</h1>
  ${watchedSection}
  <form method="POST" action="${path}" style="margin-top:1.5rem">
    <label>Adaugă o dată:
      <input type="date" name="date" value="${tomorrow()}" required>
    </label>
    <button type="submit" name="action" value="watch">Urmărește această dată</button>
  </form>
</body>
</html>`;
}

export function renderConfirmPage(message: string, path: string): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="2;url=${path}">
  <title>Valcroft</title>
  <style>body{font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
  <p>${message}</p>
  <p><small>Redirecționare automată în 2 secunde…</small></p>
  <p><a href="${path}">Înapoi</a></p>
</body>
</html>`;
}

export function renderErrorPage(message: string, path: string): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <title>Valcroft — Eroare</title>
  <style>body{font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem}p{color:#c0392b}</style>
</head>
<body>
  <h1>Eroare</h1>
  <p>${message}</p>
  <p><a href="${path}">Înapoi</a></p>
</body>
</html>`;
}
```

`renderConfirmPage` and `renderErrorPage` are unchanged.

**Step 2:** No commit yet. Typecheck still failing (worker.ts).

---

### Task 3: Rewrite `src/worker.ts` for multi-date

**Files:**
- Modify: `src/worker.ts`

**What:** Update imports, rewrite `runScheduled` to loop over each watched date, rewrite POST handlers for per-date stop + idempotent watch, update the GET handler to pass the list to `renderWatchPage`. `isWatchExpired` and `isDailyReportTick` at the bottom stay unchanged.

**Step 1: Update imports**

Replace the top of `src/worker.ts`:

```ts
import { fetchPage } from "./fetcher";
import { parseAvailability, type Slot } from "./parser";
import {
  readWatched, writeWatched, addWatchedDate, removeWatchedDate,
  readRecipients, diffSlots, slotsToStored,
  type WatchedDate,
} from "./state";
import { sendInitialEmail, sendNewSlotsEmail, sendOccupancyEmail, sendExpiryEmail, sendManualStopEmail, sendDailyReportEmail } from "./notify";
import { renderWatchPage, renderConfirmPage, renderErrorPage } from "./ui";
```

Note: `clearWatched` is removed from the import; `addWatchedDate`, `removeWatchedDate`, and the `WatchedDate` type are added.

**Step 2: Replace `runScheduled` entirely**

```ts
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
```

**Step 3: Replace `handleFetch` entirely**

```ts
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
```

**Step 4: Keep `isWatchExpired` and `isDailyReportTick` at the bottom unchanged.**

**Step 5: Run typecheck**

```
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```
git add src/state.ts src/ui.ts src/worker.ts
git commit -m "feat: watch multiple dates simultaneously"
```

NO `Co-Authored-By` trailer.

---

### Task 4: Deploy & verify

**Step 1: Deploy**

```
npx wrangler deploy
```

Expected: `Deployed valcroft-availability-notifier triggers ... schedule: */15 * * * *`.

**Step 2: Smoke test in browser**

Open `https://valcroft.claudiu.dev/rezervari-pescuit`.

Expected behaviour:
- Page loads. The in-flight watch (single date) appears in the list with an "Oprește" button next to it.
- Date picker is visible below the list.
- Adding a second date sends an initial email and updates the list.
- Re-submitting the same date produces a "deja urmărită" confirmation, no duplicate email.
- Stopping a date removes it from the list and sends the manual-stop email.

**Step 3: Tail logs**

```
npx wrangler tail
```

At the next cron tick:
- `parsed` log lines should appear once per active date.
- `done` log includes `active` and `expired` counts.

**Step 4: Confirm KV shape**

```
npx wrangler kv key get --binding=KV watched
```

Expected: a JSON array of `WatchedDate` entries.
