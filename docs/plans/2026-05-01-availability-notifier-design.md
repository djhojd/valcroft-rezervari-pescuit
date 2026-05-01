# Valcroft availability notifier — design

**Date:** 2026-05-01
**Author:** djhojd

## Goal

Watch <https://valcroft.ro/rezervari-pescuit/> on a schedule and email a fixed
list of recipients whenever a fishing-pontoon spot in the **current week**
transitions from "not available" to "available" since the last check.

Scope for v1:

- Current week only (Mon–Sun, Europe/Bucharest). Future weeks deferred.
- Edge-triggered: only newly-available slots are reported; ongoing availability
  is silent after the first notification.
- Recipients are a fixed list of personal addresses, hot-editable without
  redeploy.
- Hourly check.

## Site behavior

- The page uses the WordPress **Booked** plugin (`booked-frontend-agents`).
- Each pontoon is a `<table data-calendar-id="N">` preceded by `<p>Ponton X</p>`.
- 45 calendar tables in total; `calId=32` has no preceding label and is treated
  as an unlabeled template — skipped.
- Availability is **server-rendered** into the HTML via cell CSS classes:
  - `booked` → taken
  - `prev-date` → not bookable (past, or otherwise blocked)
  - `prev-month` → filler day from the adjacent month
  - empty class on a `<td>` → **available**
- Day numbers live in `<span class="date">` inside each `<td>`.
- The page renders the current month per pontoon by default; no AJAX is
  required for current-month state.

## Architecture

A single Cloudflare Worker, triggered hourly by a Cron Trigger.

```
[Cron 0 * * * *] → Worker scheduled handler
                       │
                       ├── fetch https://valcroft.ro/rezervari-pescuit/   (HTML)
                       ├── parse with HTMLRewriter → list of (calId, pontoon, date) currently available
                       ├── filter to current week (Mon–Sun, Europe/Bucharest)
                       ├── read previous snapshot from KV
                       ├── diff → newly-available (in current, not in previous)
                       ├── if diff non-empty → for each recipient, env.EMAIL.send(...)
                       └── write current snapshot back to KV
```

State lives in KV:

- `recipients` — JSON array of email addresses, e.g. `["me@example.com"]`.
  Edited from CF dashboard or `wrangler kv key put`.
- `snapshot` — JSON array of `{ calId, date }` slots reported on the previous
  successful run. Managed by the Worker.

## Components

| Module             | Responsibility                                                  |
|--------------------|------------------------------------------------------------------|
| `src/worker.ts`    | `scheduled()` handler — orchestrates the run                    |
| `src/fetcher.ts`   | `fetchPage(url)` — HTTPS GET with UA, retry on 5xx              |
| `src/parser.ts`    | `parseAvailability(html)` — HTMLRewriter pass → slot list       |
| `src/week.ts`      | `currentWeek(now)` → Mon–Sun bounds in `Europe/Bucharest`       |
| `src/state.ts`     | `readSnapshot(kv)` / `writeSnapshot(kv, slots)`                 |
| `src/notify.ts`    | `sendEmails(diff, recipients, env)` — Email Workers binding     |

Slot identity for diffing is `(calId, date)` where `date` is `YYYY-MM-DD`.
Pontoon name is informational only — renaming a pontoon does not produce a
false-positive opening.

## Data flow

1. **Fetch.** `GET https://valcroft.ro/rezervari-pescuit/` with
   `User-Agent: valcroft-availability-monitor/1.0` and `Accept-Language: ro-RO`.
2. **Parse.** Streaming HTMLRewriter pass:
   - Track `currentLabel` from `<p>` text matching `/^Ponton\s+\d+/`.
   - On `<table data-calendar-id="N">`, attach `currentLabel` to the table.
     Tables with no label are dropped.
   - Read the displayed month and year from the table header.
   - For each `<td>`: take the day number from `<span class="date">` and the
     class list from the `<td>`. A cell is **available** iff its class list
     contains none of `booked`, `prev-date`, `prev-month`. Compose the date as
     `YYYY-MM-DD` from the table's month/year and the day.
3. **Filter to current week.** `currentWeek(now)` returns
   `{ start, end }` for Mon 00:00 → Sun 23:59:59 in `Europe/Bucharest`. Workers
   run in UTC; we derive local date with `Intl.DateTimeFormat` against the TZ.
   Slots outside the week are dropped.
4. **Diff.** `current \ previous`, keyed by `${calId}:${date}`. Disappearances
   are not reported.
5. **Notify.** For each recipient in KV `recipients`:
   - Build a MIME message with `mimetext` from `env.SENDER_EMAIL` to the
     recipient. Subject: `"Valcroft: N spots opened this week"`. Body groups
     openings by pontoon, `Ponton X — Mon 4 May`, with a link back to the
     reservation page.
   - Call `env.EMAIL.send(new EmailMessage(sender, recipient, raw))`.
6. **Save.** `writeSnapshot(KV, current)`.

## Edge cases

- **Week spans two months.** The page only renders the current month per
  pontoon, so the first/last partial week of a month may miss days that fall
  in the adjacent month. Accepted for v1; if needed, a follow-up adds a second
  fetch with the Booked plugin's month query string.
- **First run.** No `snapshot` key exists. Treat previous as empty → first
  email lists every currently-available slot in the week. No special-case.
- **Site down / 5xx / parse failure.** Log, exit, do **not** touch KV. Next
  cron retries.
- **Year rollover.** Use the year from the calendar header, not `now.getFullYear`.

## Configuration

`wrangler.jsonc`:

- Cron trigger: `0 * * * *`.
- KV namespace binding: `KV` (one namespace, two keys: `recipients`, `snapshot`).
- Vars:
  - `PAGE_URL` — `https://valcroft.ro/rezervari-pescuit/`
  - `SENDER_EMAIL` — e.g. `monitor@<one-of-your-cf-domains>`
- `send_email` binding:
  ```jsonc
  "send_email": [{ "name": "EMAIL", "destination_address": null }]
  ```

One-time setup outside code:

1. Enable **Email Routing** on the chosen sender domain in the CF dashboard.
2. Add each personal address as a **destination address** and click the
   verification link.
3. Create the KV namespace, set initial `recipients` value.
4. Deploy. Email Workers can then send to any verified destination.

## Failure handling

- `fetch` fails / 5xx / timeout → log, exit, don't touch KV.
- Parse yields zero pontoons → log loudly, exit, don't touch KV.
- Email fails for **some** recipients → log per-recipient, continue, write
  snapshot. The missed notification is dropped rather than retried.
- Email fails for **all** recipients → log, exit, don't write snapshot; next
  hour retries the same diff.
- KV write failure after success → log via `console.error`. CF retries the
  scheduled handler.

The system is at-least-once: an opening can be reported twice if email
succeeds but the KV write fails. Acceptable.

## Observability

`console.log` / `console.error` per run, surfaced via `wrangler tail` and
Logpush. Each run logs: pontoons parsed, slots in current week, diff size,
recipient count, per-recipient send result.

## Manual operations

| Need                          | How                                                                                  |
|-------------------------------|---------------------------------------------------------------------------------------|
| Add/remove recipient          | Verify the address in Email Routing once, then update KV `recipients`.                |
| Force a fresh "all available" | `wrangler kv key delete --namespace-id=... snapshot` — next run treats prior empty. |
| Pause notifications           | Disable cron trigger or remove from `wrangler.jsonc` and redeploy.                    |
| Trigger a one-off run         | `wrangler dev --test-scheduled`, or `curl` the dev `__scheduled` endpoint.            |

## Repo layout

```
.
├─ src/
│  ├─ worker.ts
│  ├─ fetcher.ts
│  ├─ parser.ts
│  ├─ week.ts
│  ├─ state.ts
│  └─ notify.ts
├─ wrangler.jsonc
├─ package.json
├─ tsconfig.json
├─ .gitignore
├─ README.md
└─ docs/plans/2026-05-01-availability-notifier-design.md
```

## Out of scope for v1

- Tests (postponed by user request; will be added later).
- Future-week monitoring (current week only for v1).
- Cross-month week handling (deferred until it bites).
- Telegram / push / other channels.
- Per-pontoon recipient routing.
