# Daily Report Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Send a daily email at 19:00 Bucharest time summarising slots opened up / booked for the watched date in the last 24 hours.

**Architecture:** Reuse the existing `*/15 * * * *` cron. At each tick, after the existing 07:00 expiry check, detect "Bucharest local hour is 19, minute is 0" via `Intl.DateTimeFormat` and run a daily-report branch that diffs the current parsed slots against a `snapDaily` snapshot stored on the watched state. Refresh `snapDaily` after a successful send.

**Tech Stack:** Cloudflare Workers, Workers KV, Email Workers (`cloudflare:email`), `mimetext/browser`, TypeScript.

**Project state (read before starting):**
- `src/state.ts` — defines `WatchedState`, `StoredSlot`, `diffSlots`, `slotsToStored`, KV accessors.
- `src/parser.ts` — `Slot = { calId, pontoon, date }`.
- `src/notify.ts` — existing email functions (initial / new-slots / occupancy / expiry / manual-stop). Shares `buildSlotList`, `formatSlotDate`, `formatDateLong`.
- `src/worker.ts` — `scheduled` handler with expiry / parse / new-slots / hourly-occupancy branches, plus `isWatchExpired`. `handleFetch` for the UI.
- `wrangler.jsonc` — cron `*/15 * * * *`, KV binding `KV`, send_email binding `EMAIL`, `SECRET_PATH` var.
- `worker-configuration.d.ts` — `Cloudflare.Env` type.

**Verification commands:**
- `npm run typecheck` — TypeScript check (must pass after every task that changes a `.ts` file).
- `npx wrangler deploy` — deploy to production.
- `npx wrangler tail` — live logs to verify the 19:00 tick.

**No test framework in this repo.** Each task ends with `npm run typecheck` + commit. End-to-end verification is via `wrangler tail` at the 19:00 Bucharest tick after deploy.

---

### Task 1: Extend `WatchedState` with `snapDaily`

**Files:**
- Modify: `src/state.ts`

**What:** Add `snapDaily: Slot[]` (full Slot, not StoredSlot — we need `pontoon` to render the "booked" list, since those slots are absent from the current parse). Default to `[]` in `readWatched` so the in-flight watch survives the deploy.

**Step 1: Edit `src/state.ts`**

Add `Slot` to the import:

```ts
import type { Slot } from "./parser";
```

Update the type:

```ts
export type WatchedState = {
  date: string;
  snap15: StoredSlot[];
  countHourly: number;
  snapDaily: Slot[]; // snapshot taken at the previous 19:00 tick
};
```

Update `readWatched` to default the new field:

```ts
export async function readWatched(kv: KVNamespace): Promise<WatchedState | null> {
  try {
    const raw = await kv.get("watched", "json");
    if (raw && typeof (raw as WatchedState).date === "string") {
      const w = raw as Partial<WatchedState> & { date: string; snap15: StoredSlot[]; countHourly: number };
      return {
        date: w.date,
        snap15: w.snap15,
        countHourly: w.countHourly,
        snapDaily: Array.isArray(w.snapDaily) ? w.snapDaily : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}
```

**Step 2: Run typecheck**

```
npm run typecheck
```

Expected: errors in `src/worker.ts` for `writeWatched` calls (missing `snapDaily`). That's the next task.

**Step 3: Commit (after Task 2 — these are paired)**

Wait until Task 2 fixes the call sites; commit them together.

---

### Task 2: Wire `snapDaily` through the watch lifecycle

**Files:**
- Modify: `src/worker.ts`

**What:** Initialise `snapDaily: []` when a watch is registered. Preserve `watched.snapDaily` on every scheduled-tick write (we are not yet writing into it — that's Task 4).

**Step 1: Edit the `action === "watch"` handler in `src/worker.ts`**

Find:

```ts
await writeWatched(env.KV, {
  date,
  snap15: slotsToStored(dateSlots),
  countHourly: dateSlots.length,
});
```

Replace with:

```ts
await writeWatched(env.KV, {
  date,
  snap15: slotsToStored(dateSlots),
  countHourly: dateSlots.length,
  snapDaily: [],
});
```

**Step 2: Edit the scheduled-tick `writeWatched` at the end of `runScheduled`**

Find:

```ts
await writeWatched(env.KV, { date: watched.date, snap15: newSnap15, countHourly: newCountHourly });
```

Replace with:

```ts
await writeWatched(env.KV, {
  date: watched.date,
  snap15: newSnap15,
  countHourly: newCountHourly,
  snapDaily: watched.snapDaily,
});
```

**Step 3: Run typecheck**

```
npm run typecheck
```

Expected: PASS.

**Step 4: Commit Tasks 1 + 2 together**

```
git add src/state.ts src/worker.ts
git commit -m "feat: add snapDaily field to watched state"
```

---

### Task 3: Add `sendDailyReportEmail`

**Files:**
- Modify: `src/notify.ts`

**What:** New email function for the daily report. Handles three cases: first report (baseline), normal report with changes, normal report with no changes.

**Step 1: Add the function at the bottom of `src/notify.ts`**

```ts
/** Sent daily at 19:00 Bucharest. Summarises slots opened/booked in the last 24h. */
export async function sendDailyReportEmail(
  date: string,
  added: Slot[],
  booked: Slot[],
  currentTotal: number,
  isFirst: boolean,
  recipients: string[],
  env: NotifyEnv
): Promise<SendResult[]> {
  const dateLabel = formatDateLong(date);
  const calendarLink = `<p><a href="${env.PAGE_URL}">Vezi calendarul</a></p>`;

  if (isFirst) {
    const subject = `Valcroft: urmărire pornită pentru ${formatSlotDate(date)} — ${currentTotal} ${currentTotal === 1 ? "loc liber" : "locuri libere"}`;
    const body = currentTotal === 0
      ? `<p>Urmărire pornită pentru <strong>${dateLabel}</strong>. Niciun loc liber momentan.</p>${calendarLink}`
      : `<p>Urmărire pornită pentru <strong>${dateLabel}</strong>. Situație curentă:</p>${buildSlotList(added, env.PAGE_URL)}`;
    return sendEmailToAll(subject, body, recipients, env);
  }

  const subject = `Valcroft: raport zilnic pentru ${formatSlotDate(date)} — +${added.length} / -${booked.length}`;

  if (added.length === 0 && booked.length === 0) {
    const body = `<p>Nicio modificare în ultimele 24 de ore pentru <strong>${dateLabel}</strong>.</p>
<p><strong>${currentTotal}</strong> ${currentTotal === 1 ? "loc liber" : "locuri libere"} acum.</p>${calendarLink}`;
    return sendEmailToAll(subject, body, recipients, env);
  }

  const addedSection = added.length > 0
    ? `<p><strong>Locuri eliberate (${added.length}):</strong></p>${buildSlotList(added, env.PAGE_URL)}`
    : "";
  const bookedSection = booked.length > 0
    ? `<p><strong>Locuri rezervate (${booked.length}):</strong></p>${buildSlotList(booked, env.PAGE_URL)}`
    : "";
  const totalLine = `<p><strong>${currentTotal}</strong> ${currentTotal === 1 ? "loc liber" : "locuri libere"} acum pe <strong>${dateLabel}</strong>.</p>`;
  const body = `${addedSection}${bookedSection}${totalLine}${calendarLink}`;
  return sendEmailToAll(subject, body, recipients, env);
}
```

`buildSlotList` already groups by pontoon and links to `PAGE_URL`, so the same renderer works for both `added` and `booked` lists.

**Step 2: Run typecheck**

```
npm run typecheck
```

Expected: PASS.

**Step 3: Commit**

```
git add src/notify.ts
git commit -m "feat: add sendDailyReportEmail"
```

---

### Task 4: Daily-report branch in `scheduled`

**Files:**
- Modify: `src/worker.ts`

**What:** Add an `isDailyReportTick` utility (Bucharest hour 19, minute 0) and a branch that runs after expiry/parse, before the existing new-slots / occupancy branches. Compute `added` and `booked`, send the report, and update `snapDaily` on success.

**Step 1: Add the import in `src/worker.ts`**

Update the notify import:

```ts
import { sendInitialEmail, sendNewSlotsEmail, sendOccupancyEmail, sendExpiryEmail, sendManualStopEmail, sendDailyReportEmail } from "./notify";
```

**Step 2: Add `isDailyReportTick` next to `isWatchExpired`**

At the bottom of `src/worker.ts`, after `isWatchExpired`:

```ts
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
```

The `*/15` cron fires at :00, :15, :30, :45, so the minute check ensures we only fire once per day at the 19:00 tick.

**Step 3: Add the daily-report branch in `runScheduled`**

Insert this block in `src/worker.ts` immediately after the `console.log(... "parsed" ...)` line (just before the `// ── 15-min edge diff` comment):

```ts
// ── Daily report at 19:00 Bucharest ───────────────────────────────────────
let dailySendFailed = false;
let dailyDidSend = false;
if (isDailyReportTick(new Date(event.scheduledTime)) && recipients.length > 0) {
  const seen = new Set(dateSlots.map((s) => `${s.calId}:${s.date}`));
  const booked = watched.snapDaily.filter((s) => !seen.has(`${s.calId}:${s.date}`));
  const added = diffSlots(dateSlots, watched.snapDaily);
  const isFirst = watched.snapDaily.length === 0;
  const results = await sendDailyReportEmail(
    watched.date,
    isFirst ? dateSlots : added,
    booked,
    dateSlots.length,
    isFirst,
    recipients,
    env
  );
  for (const r of results) {
    if (r.ok) console.log(JSON.stringify({ event: "daily_report_sent", recipient: r.recipient }));
    else console.error(JSON.stringify({ event: "daily_report_failed", recipient: r.recipient, error: r.error }));
  }
  dailySendFailed = results.every((r) => !r.ok);
  dailyDidSend = true;
}
```

Note: for the first report we pass `dateSlots` as the "added" list, since the email body for `isFirst` renders the current snapshot from that arg.

**Step 4: Update the final `writeWatched` to refresh `snapDaily` on success**

Replace the block from Task 2:

```ts
await writeWatched(env.KV, {
  date: watched.date,
  snap15: newSnap15,
  countHourly: newCountHourly,
  snapDaily: watched.snapDaily,
});
```

with:

```ts
const newSnapDaily = (dailyDidSend && !dailySendFailed)
  ? dateSlots
  : watched.snapDaily;
await writeWatched(env.KV, {
  date: watched.date,
  snap15: newSnap15,
  countHourly: newCountHourly,
  snapDaily: newSnapDaily,
});
```

**Step 5: Run typecheck**

```
npm run typecheck
```

Expected: PASS.

**Step 6: Commit**

```
git add src/worker.ts
git commit -m "feat: send daily 19:00 report for watched date"
```

---

### Task 5: Deploy & verify

**Step 1: Deploy**

```
npx wrangler deploy
```

Expected: `Deployed valcroft-availability-notifier triggers ... schedule: */15 * * * *`.

**Step 2: Tail logs and wait for the 19:00 Bucharest tick**

```
npx wrangler tail
```

At 19:00 Bucharest local time the log should contain either `daily_report_sent` or `daily_report_failed` entries.

**Step 3: Confirm email arrived**

Subject pattern: `Valcroft: urmărire pornită pentru …` (first report on an existing watch — `snapDaily` was empty before deploy) or `Valcroft: raport zilnic pentru … — +N / -M` on subsequent days.

**Step 4: Confirm `snapDaily` persisted**

```
npx wrangler kv key get --binding=KV watched
```

Expected: JSON output contains a non-empty `snapDaily` array after a successful 19:00 send.
