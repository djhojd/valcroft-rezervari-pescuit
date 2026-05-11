# Daily Report Design

**Date:** 2026-05-08
**Status:** Approved

## Goal

Send a daily email at 19:00 Bucharest time summarising what changed for the watched date in the last 24 hours: which pontoons opened up and which were booked.

## Scope

- Only the currently watched date. If no watch is active at 19:00, no report.
- Daily heartbeat: report is sent even when nothing changed (carries a "no changes" note).
- First report after a watch starts: sends current snapshot as a baseline, no diff.

## Architecture

Reuse the existing `*/15 * * * *` cron. At each tick:

1. Existing 07:00 expiry check (unchanged).
2. New: if Bucharest local hour is 19 and minute is 0 and a watch is active → run the daily-report branch.
3. Existing parse → 15-min new-slots → hourly occupancy branches (unchanged).

19:00 Bucharest is 16:00 UTC in summer (EEST) and 17:00 UTC in winter (EET). DST is handled by computing the Bucharest local hour via `Intl.DateTimeFormat` with `timeZone: "Europe/Bucharest"`, identical to the pattern used in `isWatchExpired`.

## Data

Extend `WatchedState` with one field:

```ts
type WatchedState = {
  date: string;
  snap15: StoredSlot[];
  countHourly: number;
  snapDaily: StoredSlot[];  // NEW: snapshot taken at the previous 19:00 tick
};
```

- `writeWatched` from `action=watch` initialises `snapDaily: []`.
- `readWatched` defaults `snapDaily` to `[]` when missing, so the in-flight watch survives the deploy without manual KV surgery.
- `clearWatched` (expiry / manual stop) clears the entire watched record, including `snapDaily`.

## Diff logic

At the 19:00 tick:

- `currentSlots = parsed slots filtered to watched.date`
- `added = currentSlots \ snapDaily`
- `booked = snapDaily \ currentSlots`

Reuse the existing `diffSlots` helper for set subtraction on the `(date, pontoon)` key.

## Email content

Function: `sendDailyReportEmail(date, added, booked, currentTotal, isFirst, recipients, env)`.

- **First report** (snapDaily was empty): subject `Valcroft: urmărire pornită pentru {date} — {N} locuri libere`. Body lists the current free pontoons.
- **Subsequent reports**: subject `Valcroft: raport zilnic pentru {date} — +{addedCount} / -{bookedCount}`. Body shows:
  - One section for opened-up pontoons (omit if none).
  - One section for booked pontoons (omit if none).
  - Current total free.
  - If both lists are empty: "Nicio modificare în ultimele 24 de ore. {N} locuri libere acum."

Pontoon lists reuse the formatter in `buildSlotList`.

## State update

After sending:

- If every recipient send failed → keep the old `snapDaily` so the next 19:00 covers 48h instead of dropping the gap.
- Otherwise → overwrite `snapDaily` with `currentSlots`.

This mirrors the at-least-once pattern used for `snap15` and `countHourly`.

## Failure modes

- **Parse fails / 0 slots** at 19:00: skip the daily branch silently (existing `parse_zero_slots` log already covers it). The next 19:00 retries.
- **Fetch fails**: same — bail before any branch runs (existing behaviour).
- **Email send fails**: keep `snapDaily` (retry next day, broader diff window).

## Out of scope

- Reports across multiple dates.
- Per-time-slot detail (only pontoon granularity matters here).
- Configurable report time.
- Tests — the repo currently has no test harness; verification is via wrangler tail at the 19:00 tick after deploy.
