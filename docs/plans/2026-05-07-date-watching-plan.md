# Date-Watching Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hourly current-week scan with a user-triggered date-watching system: pick a date in a web UI, get an immediate email, then 15-min edge-triggered alerts for new slots and hourly occupancy-decrease summaries.

**Architecture:** Single `*/15 * * * *` cron replaces the existing `0 * * * *`. The cron exits immediately when no date is watched. A new HTTP handler serves a token-protected HTML form (GET/POST) for registering and stopping a watched date. All state lives in one new KV key `watched`.

**Tech Stack:** Cloudflare Workers, Workers KV, Email Workers (`cloudflare:email`), `mimetext/browser`, TypeScript, wrangler

---

### Task 1: Update wrangler.jsonc and worker-configuration.d.ts

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts` (lines 8–13 only — the `Cloudflare.Env` interface block)

**Step 1: Swap the cron trigger in `wrangler.jsonc`**

Replace `"0 * * * *"` with `"*/15 * * * *"`:

```jsonc
"triggers": {
  "crons": ["*/15 * * * *"]
},
```

**Step 2: Add `WATCH_TOKEN` to the generated type interface**

`WATCH_TOKEN` is a secret (set via `wrangler secret put`, never in `wrangler.jsonc`), so `wrangler types` won't pick it up. Add it manually to the existing `Cloudflare.Env` block in `worker-configuration.d.ts`:

```typescript
interface Env {
  KV: KVNamespace;
  EMAIL: SendEmail;
  PAGE_URL: "https://valcroft.ro/rezervari-pescuit/";
  SENDER_EMAIL: "rezervari-pescuit@claudiu.dev";
  WATCH_TOKEN: string;
}
```

**Step 3: Commit**

```bash
git add wrangler.jsonc worker-configuration.d.ts
git commit -m "feat: swap cron to */15 and add WATCH_TOKEN type"
```

---

### Task 2: Refactor src/state.ts

**Files:**
- Modify: `src/state.ts`

Remove `readSnapshot` and `writeSnapshot` (no longer used — the current-week scan is gone). Add `WatchedState` type and its CRUD functions. Keep `StoredSlot`, `readRecipients`, and `diffSlots` unchanged.

**Step 1: Replace the contents of `src/state.ts`**

```typescript
import type { Slot } from "./parser";

export type StoredSlot = { calId: string; date: string };

export type WatchedState = {
  date: string;       // YYYY-MM-DD (Bucharest local date)
  snap15: StoredSlot[]; // slots at last 15-min tick; basis for edge diff
  countHourly: number;  // slot count at last :00 tick; basis for decrease detection
};

export async function readWatched(kv: KVNamespace): Promise<WatchedState | null> {
  try {
    const raw = await kv.get("watched", "json");
    if (raw && typeof (raw as WatchedState).date === "string") return raw as WatchedState;
    return null;
  } catch {
    return null;
  }
}

export async function writeWatched(kv: KVNamespace, state: WatchedState): Promise<void> {
  await kv.put("watched", JSON.stringify(state));
}

export async function clearWatched(kv: KVNamespace): Promise<void> {
  await kv.delete("watched");
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

**Step 2: Verify TypeScript compiles**

```bash
npx wrangler deploy --dry-run
```

Expected: no type errors.

**Step 3: Commit**

```bash
git add src/state.ts
git commit -m "refactor: replace snapshot state with WatchedState in state.ts"
```

---

### Task 3: Refactor src/notify.ts

**Files:**
- Modify: `src/notify.ts`

Replace the single `sendEmails` function with three named notification functions for the three distinct email types. Keep the internal helpers (`formatDate`, `sendEmailToAll`).

**Step 1: Replace the contents of `src/notify.ts`**

```typescript
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext/browser";
import type { Slot } from "./parser";

export type NotifyEnv = {
  EMAIL: SendEmail;
  SENDER_EMAIL: string;
  PAGE_URL: string;
};

type SendResult = { recipient: string; ok: boolean; error?: string };

const RO_WEEKDAY = ["dum", "lun", "mar", "mie", "joi", "vin", "sâm"];
const RO_MONTH_SHORT = ["ian", "feb", "mar", "apr", "mai", "iun", "iul", "aug", "sep", "oct", "noi", "dec"];
const RO_MONTH_LONG  = ["ianuarie", "februarie", "martie", "aprilie", "mai", "iunie",
                        "iulie", "august", "septembrie", "octombrie", "noiembrie", "decembrie"];

function formatSlotDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${RO_WEEKDAY[wd]} ${d} ${RO_MONTH_SHORT[m - 1]}`;
}

export function formatDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const weekdays = ["duminică", "luni", "marți", "miercuri", "joi", "vineri", "sâmbătă"];
  return `${weekdays[wd]}, ${d} ${RO_MONTH_LONG[m - 1]} ${y}`;
}

function buildSlotList(slots: Slot[], pageUrl: string): string {
  const groups = new Map<string, string[]>();
  for (const s of slots) {
    const arr = groups.get(s.pontoon) ?? [];
    arr.push(s.date);
    groups.set(s.pontoon, arr);
  }
  const sortedPontoons = [...groups.keys()].sort((a, b) => {
    const na = parseInt(a.replace(/\D+/g, ""), 10) || 0;
    const nb = parseInt(b.replace(/\D+/g, ""), 10) || 0;
    return na - nb;
  });
  const items = sortedPontoons
    .map((p) => {
      const dates = groups.get(p)!.sort().map(formatSlotDate).join(", ");
      return `<li><strong>${p}</strong> — ${dates}</li>`;
    })
    .join("");
  return `<ul>${items}</ul><p><a href="${pageUrl}">Rezervă acum</a></p>`;
}

async function sendEmailToAll(
  subject: string,
  html: string,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const recipient of recipients) {
    try {
      const msg = createMimeMessage();
      msg.setSender({ name: "Valcroft Monitor", addr: env.SENDER_EMAIL });
      msg.setRecipient(recipient);
      msg.setSubject(subject);
      msg.addMessage({ contentType: "text/html", data: html });
      const message = new EmailMessage(env.SENDER_EMAIL, recipient, msg.asRaw());
      await env.EMAIL.send(message);
      results.push({ recipient, ok: true });
    } catch (e) {
      results.push({ recipient, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** Sent immediately when user registers a watched date. Lists all current free slots. */
export async function sendInitialEmail(
  date: string,
  slots: Slot[],
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const dateLabel = formatDateLong(date);
  const count = slots.length;
  const subject = `Valcroft: urmărire activată pentru ${formatSlotDate(date)} — ${count} ${count === 1 ? "loc liber" : "locuri libere"}`;
  const body = count === 0
    ? `<p>Niciun loc disponibil momentan pe <strong>${dateLabel}</strong>. Vei fi notificat imediat ce apar locuri libere.</p><p><a href="${env.PAGE_URL}">Vezi calendarul</a></p>`
    : `<p>Locuri disponibile pe <strong>${dateLabel}</strong>:</p>${buildSlotList(slots, env.PAGE_URL)}`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent every 15 min when new slots have opened since last check. */
export async function sendNewSlotsEmail(
  date: string,
  newSlots: Slot[],
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const count = newSlots.length;
  const subject = `Valcroft: ${count} ${count === 1 ? "loc nou" : "locuri noi"} pe ${formatSlotDate(date)}`;
  const body = `<p>Locuri noi disponibile pe <strong>${formatDateLong(date)}</strong>:</p>${buildSlotList(newSlots, env.PAGE_URL)}`;
  return sendEmailToAll(subject, body, recipients, env);
}

/** Sent every hour when the total free count has decreased since the previous hour. */
export async function sendOccupancyEmail(
  date: string,
  remaining: number,
  taken: number,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const subject = `Valcroft: ${remaining} ${remaining === 1 ? "loc rămas" : "locuri rămase"} pe ${formatSlotDate(date)}`;
  const body = `<p>Pe <strong>${formatDateLong(date)}</strong>: <strong>${remaining}</strong> ${remaining === 1 ? "loc liber" : "locuri libere"} rămase.</p>
<p>${taken} ${taken === 1 ? "a fost rezervat" : "au fost rezervate"} în ultima oră.</p>
<p><a href="${env.PAGE_URL}">Rezervă acum</a></p>`;
  return sendEmailToAll(subject, body, recipients, env);
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx wrangler deploy --dry-run
```

**Step 3: Commit**

```bash
git add src/notify.ts
git commit -m "refactor: replace sendEmails with three typed notification functions"
```

---

### Task 4: Add src/ui.ts

**Files:**
- Create: `src/ui.ts`

**Step 1: Create the file**

```typescript
import type { WatchedState } from "./state";
import { formatDateLong } from "./notify";

function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function renderWatchPage(watched: WatchedState | null, token: string): string {
  const defaultDate = watched?.date ?? tomorrow();
  const statusHtml = watched
    ? `<p>Urmărești: <strong>${formatDateLong(watched.date)}</strong><br>
       Verificare la fiecare 15 minute.</p>`
    : `<p>Nicio dată urmărită momentan.</p>`;
  const stopButton = watched
    ? `<button type="submit" name="action" value="stop" style="background:#c0392b;color:#fff">Oprește urmărirea</button>`
    : "";

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
    button { padding: .5rem 1.2rem; font-size: 1rem; cursor: pointer; margin-right: .5rem; }
  </style>
</head>
<body>
  <h1>Valcroft — Urmărire disponibilitate</h1>
  ${statusHtml}
  <form method="POST" action="/?token=${token}">
    <label>Alege o dată:
      <input type="date" name="date" value="${defaultDate}" required>
    </label>
    <button type="submit" name="action" value="watch">Urmărește această dată</button>
    ${stopButton}
  </form>
</body>
</html>`;
}

export function renderConfirmPage(message: string, token: string): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="2;url=/?token=${token}">
  <title>Valcroft</title>
  <style>body{font-family:sans-serif;max-width:480px;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
  <p>${message}</p>
  <p><small>Redirecționare automată în 2 secunde…</small></p>
  <p><a href="/?token=${token}">Înapoi</a></p>
</body>
</html>`;
}

export function renderErrorPage(message: string, token: string): string {
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
  <p><a href="/?token=${token}">Înapoi</a></p>
</body>
</html>`;
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx wrangler deploy --dry-run
```

**Step 3: Commit**

```bash
git add src/ui.ts
git commit -m "feat: add UI rendering helpers for watch page"
```

---

### Task 5: Rewrite src/worker.ts

**Files:**
- Modify: `src/worker.ts`

This is the main task. The `fetch()` handler gains the web UI. The `scheduled()` handler drops the current-week logic and gains the watched-date logic.

**Step 1: Replace the full contents of `src/worker.ts`**

```typescript
import { fetchPage } from "./fetcher";
import { parseAvailability } from "./parser";
import { readWatched, writeWatched, clearWatched, readRecipients, diffSlots, slotsToStored } from "./state";
import { sendInitialEmail, sendNewSlotsEmail, sendOccupancyEmail } from "./notify";
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

  // Auto-expire: if watched date is already in the past, clear and exit.
  const today = todayBucharest(new Date(event.scheduledTime));
  if (watched.date < today) {
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

  const allSlots = await parseAvailability(html);
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

  await writeWatched(env.KV, { date: watched.date, snap15: newSnap15, countHourly: newCountHourly });
  console.log(JSON.stringify({ event: "done", durationMs: Date.now() - start, date: watched.date }));
}

// ── HTTP handler (web UI) ────────────────────────────────────────────────────

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  if (token !== env.WATCH_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method === "GET") {
    const watched = await readWatched(env.KV);
    return new Response(renderWatchPage(watched, token), {
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
      await clearWatched(env.KV);
      console.log(JSON.stringify({ event: "watch_stopped" }));
      return new Response(renderConfirmPage("Urmărire oprită.", token), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (action === "watch") {
      const date = (formData.get("date") as string | null) ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return new Response(renderErrorPage("Data introdusă este invalidă.", token), {
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
        return new Response(renderErrorPage("Eroare la accesarea site-ului. Încearcă din nou.", token), {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const allSlots = await parseAvailability(html);
      const dateSlots = allSlots.filter((s) => s.date === date);
      const recipients = await readRecipients(env.KV);

      if (recipients.length > 0) {
        const results = await sendInitialEmail(date, dateSlots, recipients, env);
        for (const r of results) {
          if (r.ok) console.log(JSON.stringify({ event: "initial_email_sent", recipient: r.recipient }));
          else console.error(JSON.stringify({ event: "initial_email_failed", recipient: r.recipient, error: r.error }));
        }
        if (results.every((r) => !r.ok)) {
          return new Response(renderErrorPage("Eroare la trimiterea emailului. Încearcă din nou.", token), {
            status: 502,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      await writeWatched(env.KV, {
        date,
        snap15: slotsToStored(dateSlots),
        countHourly: dateSlots.length,
      });

      const count = dateSlots.length;
      const slotsText = count === 0
        ? "Niciun loc disponibil momentan — vei fi notificat imediat ce apar."
        : `${count} ${count === 1 ? "loc liber" : "locuri libere"} trimis${count === 1 ? "" : "e"} pe email.`;
      console.log(JSON.stringify({ event: "watch_registered", date, slots: count }));
      return new Response(renderConfirmPage(`Urmărire activată pentru ${date}. ${slotsText}`, token), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Bad Request", { status: 400 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function todayBucharest(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx wrangler deploy --dry-run
```

Expected: clean compile with no type errors.

**Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: add date-watching scheduled + web UI handlers to worker"
```

---

### Task 6: Delete src/week.ts

**Files:**
- Delete: `src/week.ts`

`currentWeekDates` is no longer called from anywhere. `todayBucharest` logic now lives inline in `worker.ts`.

**Step 1: Verify nothing imports week.ts**

```bash
grep -r "from.*week" src/
```

Expected: no output (no imports remaining).

**Step 2: Delete the file**

```bash
git rm src/week.ts
```

**Step 3: Verify TypeScript still compiles**

```bash
npx wrangler deploy --dry-run
```

**Step 4: Commit**

```bash
git commit -m "refactor: remove week.ts (current-week scan replaced by date-watching)"
```

---

### Task 7: Set WATCH_TOKEN secret and smoke-test locally

**Step 1: Set the secret in production**

Pick any random string (e.g., run `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` in a terminal):

```bash
npx wrangler secret put WATCH_TOKEN
```

Wrangler will prompt for the value. Paste your generated token.

**Step 2: Start local dev server**

```bash
npx wrangler dev
```

**Step 3: Test GET — page renders**

Open in browser: `http://localhost:8787/?token=dev` (wrangler dev exposes secrets from a `.dev.vars` file; create one first):

Create `.dev.vars` (already git-ignored by wrangler default):
```
WATCH_TOKEN=dev
```

Restart wrangler dev. Navigate to `http://localhost:8787/?token=dev`.

Expected: HTML page with date picker and "Urmărește această dată" button.

**Step 4: Test POST watch**

Submit the form with a future date.

Expected: confirmation page showing slot count, then redirect back to the UI showing the watched date with a "Oprește urmărirea" button.

**Step 5: Test scheduled handler**

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

Expected: wrangler logs show `scheduled_noop` if no date is watched, or `parsed`/`done` events if a date is registered.

**Step 6: Test POST stop**

Click "Oprește urmărirea" in the browser.

Expected: confirmation page, then redirect to idle UI.

**Step 7: Test 403**

```bash
curl -i "http://localhost:8787/?token=wrong"
```

Expected: `HTTP/1.1 403 Forbidden`.

---

### Task 8: Deploy and final smoke test

**Step 1: Deploy to production**

```bash
npx wrangler deploy
```

**Step 2: Smoke-test the UI**

Navigate to `https://valcroft-availability-notifier.<your-workers-subdomain>.workers.dev/?token=<your-token>`.

Expected: HTML page renders. Submit a future date and verify an email arrives.

**Step 3: Verify the cron now runs every 15 minutes**

In the Cloudflare dashboard → Workers → valcroft-availability-notifier → Triggers, confirm the cron shows `*/15 * * * *`.

**Step 4: Commit any final adjustments and push**

```bash
git push origin main
```

---

### Notes

- The old `snapshot` KV key is now orphaned (never read or written). It can be deleted manually with `wrangler kv:key delete --binding=KV snapshot` after deploying — not required but keeps KV tidy.
- `.dev.vars` must NOT be committed — it is already in `.gitignore` by wrangler convention. If it isn't there yet, add it.
- The `recipients` KV key is still read the same way; email addresses in KV are unchanged.
