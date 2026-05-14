# Multi-Date Watching Design

**Date:** 2026-05-08
**Status:** Approved

## Goal

Let the user watch multiple dates simultaneously. Each date is added and stopped independently and auto-expires at its own 07:00 Bucharest cutoff.

## Scope

- UI shows a list of currently watched dates with per-date "Oprește" buttons, plus an always-visible date picker to add another.
- Cron loops over every watched date and produces independent emails per date (initial, new-slots, hourly occupancy, daily 19:00 report, expiry, manual stop).
- One page fetch + parse per cron tick covers all dates.

## Approach

Single KV key `watched` stores an array of `WatchedDate`. One read and one write per tick. Existing in-flight single-object record is auto-wrapped into a one-entry array on first read — zero-downtime deploy.

Rejected alternative: one KV key per date. Adds `kv.list()` overhead with no win at this scale (handful of dates).

## Data model

```ts
// state.ts
export type WatchedDate = {
  date: string;
  snap15: StoredSlot[];
  countHourly: number;
  snapDaily: Slot[];
};

// KV key "watched" holds: WatchedDate[]
```

State accessors:

- `readWatched(kv) → WatchedDate[]`
  - Legacy object shape → wrap as `[obj]`.
  - Array shape → use as-is; default each entry's `snapDaily` to `[]`.
  - Missing / unparseable → `[]`.
- `writeWatched(kv, list)` — writes the entire array.
- `addWatchedDate(kv, entry)` — appends; idempotent (no-op if date already present).
- `removeWatchedDate(kv, date)` — removes the entry for `date`; no-op if absent.

`clearWatched` is removed.

## Scheduled handler

```
list = readWatched(kv)
if list empty → log noop, return

expired = list.filter(w => isWatchExpired(w.date, now))
active  = list.filter(w => !isWatchExpired(w.date, now))

for w in expired: sendExpiryEmail(w.date, ...)
if active empty → writeWatched(kv, []); return

html  = fetchPage(...)           # bail on failure
slots = parseAvailability(html)  # bail on failure
if slots.length === 0 → bail without writing (preserve state)

updated = []
for w in active:
  dateSlots = slots.filter(s => s.date === w.date)
  # existing single-date logic: new-slots diff, hourly occupancy, 19:00 daily report
  # compute newSnap15 / newCountHourly / newSnapDaily with at-least-once retention
  updated.push({ date: w.date, snap15: newSnap15, countHourly: newCountHourly, snapDaily: newSnapDaily })

writeWatched(kv, updated)
```

One fetch + parse covers every watched date. Per-date logic is the existing single-date branch wrapped in a loop. Per-date at-least-once semantics (keep old `snap15` / `countHourly` / `snapDaily` when the corresponding email fails) are preserved unchanged.

## UI & POST handlers

`renderWatchPage(list, path)`:

- List of watched dates (each row: date label + form posting `action=stop&date=YYYY-MM-DD`). Empty list shows "Nicio dată urmărită momentan."
- Date picker + "Urmărește această dată" submit always shown below the list.

POST routing:

- `action=watch&date=…` → validate, fetch + parse once, filter to `date`, `sendInitialEmail`, `addWatchedDate(...)`. If already watched: no-op (no duplicate email).
- `action=stop&date=…` → `sendManualStopEmail(date, ...)`, `removeWatchedDate(env.KV, date)`. If date not in list: no-op.

No "stop all" button.

## Failure modes

- Legacy in-flight record reads as a one-entry array — zero downtime.
- Per-date at-least-once: each entry independently retains its prior `snap15` / `countHourly` / `snapDaily` when its email fails.
- Fetch / parse failure aborts the whole tick without writing (preserves all entries).
- Zero recipients: emails skipped; state still updated.
- Duplicate `action=watch` for an already-watched date: idempotent no-op.

## Out of scope

- Cap on number of watched dates (no limit needed at this scale).
- Combined "all dates" digest emails (each date emits its own emails).
- Per-date custom thresholds or check intervals.
- Tests — no test harness in the repo; verification is via `wrangler tail` after deploy.
