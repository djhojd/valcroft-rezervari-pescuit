# Date-Watching Feature — Design

**Date:** 2026-05-07
**Status:** Approved

## Overview

Replace the existing hourly cron (current-week scan) with a user-triggered date-watching system. The Worker is dormant by default and only polls when a specific date has been registered via the web UI. The user can watch one date at a time, receive an immediate notification on registration, get edge-triggered alerts every 15 minutes when new slots open, and receive hourly occupancy-decrease summaries.

## Architecture

### HTTP handler (web UI)

Protected by a `WATCH_TOKEN` secret (set via `wrangler secret put WATCH_TOKEN`, never in git).

- `GET /?token=<secret>` — serves an HTML page with the current watched date (if any) and a `<input type="date">` picker.
- `POST /?token=<secret>` with `action=watch&date=YYYY-MM-DD` — fetches the page immediately, parses free slots for the date, sends an initial email, then writes watched state to KV. Returns a confirmation page with a 2-second meta-refresh back to GET.
- `POST /?token=<secret>` with `action=stop` — clears the `watched` KV key. Returns a confirmation page.
- Missing or wrong token → `403` plain text.

### Scheduled handler (`*/15 * * * *`)

Replaces the previous `0 * * * *` cron.

1. Read `watched` from KV. If absent → return immediately (idle, near-zero cost).
2. If `watched.date` is in the past (Europe/Bucharest) → delete `watched` from KV, return.
3. Fetch page, parse free slots for `watched.date`.
4. Edge diff against `watched.snap15` → if new slots appeared, send email.
5. If `scheduledTime.getMinutes() === 0` → compare slot count to `watched.countHourly`; if decreased, send occupancy email. Reset `countHourly` to current count.
6. Write updated `watched` (new `snap15`, updated `countHourly` if :00) to KV.

## KV Schema

Existing keys (`snapshot`, `recipients`) are removed (no longer used). New key:

**`watched`** — absent when idle; present when a date is active:

```json
{
  "date": "2026-05-17",
  "snap15": [
    { "calId": "32", "date": "2026-05-17" }
  ],
  "countHourly": 5
}
```

- `date` — watched date in `YYYY-MM-DD`
- `snap15` — slot list from the last 15-min tick; basis for edge diff
- `countHourly` — slot count recorded at the last :00 tick; basis for decrease detection

Written on form submit (initial `snap15` = all current free slots, `countHourly` = their count). Replaced when a new date is watched. Deleted on stop or auto-expire.

## Notification Logic

| Trigger | Condition | Email content |
|---|---|---|
| Form submit | Always | All current free slots for the date ("urmărire activată") |
| Every 15-min tick | New slots appeared vs `snap15` | Only the newly opened slots |
| Every :00 tick | Slot count < `countHourly` | Remaining slots + how many were taken since last hour |

Both the 15-min and :00 checks run at minute :00 — it's valid for both emails to fire in the same tick if the signals differ.

## Web UI

Pure HTML, no JavaScript, no external assets. Single route, two states.

**Idle state:**
```
Valcroft — Urmărire disponibilitate
Alege o dată:  [ date picker ]
[ Urmărește această dată ]
```

**Active state:**
```
Valcroft — Urmărire disponibilitate
Urmărești: sâmbătă, 17 mai 2026
Verificare la fiecare 15 minute.

Alege altă dată:  [ date picker ]
[ Urmărește această dată ]  [ Oprește urmărirea ]
```

Both actions are plain HTML `<form>` POSTs with a hidden `action` field. The date picker defaults to tomorrow (idle) or the current watched date (active). POST responses confirm success and meta-refresh to GET after 2 seconds.

## Error Handling

- **Form submit — fetch/parse failure:** Return error page, write nothing to KV.
- **Form submit — all sends fail:** Return error page, write nothing to KV (user must resubmit; at-least-once semantics).
- **Cron fetch/parse failure:** Log structured error, preserve KV state, retry next tick.
- **Parse yields 0 slots for watched date:** Valid empty state — update `snap15: []`, `countHourly: 0`. Occupancy-decrease email fires if previous count was >0.
- **Cron — all sends fail:** Skip writing snapshot (retry next tick). Partial failure: write snapshot, log failures.

## Decisions Log

- **Remove current-week cron:** The date-watching system supersedes it. The Worker is idle when no date is watched.
- **One date at a time:** Simplest model. Watching a new date replaces the previous one.
- **Auto-expire:** Watched date is cleared on the first cron tick after the date passes (Bucharest timezone). No manual cleanup needed.
- **Token as wrangler secret:** Not in `wrangler.jsonc` vars so it never appears in git history or Cloudflare dashboard plaintext.
- **No JS in UI:** `<input type="date">` provides a native calendar picker in all modern browsers. Meta-refresh handles the post-submit redirect without JS.
- **`*/15 * * * *` single cron:** Avoids double-firing at :00 that would occur with two overlapping cron entries. Hourly logic gated on `getMinutes() === 0`.
