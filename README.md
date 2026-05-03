# valcroft-availability-notifier

A Cloudflare Worker that monitors fishing-pontoon availability on
[valcroft.ro/rezervari-pescuit](https://valcroft.ro/rezervari-pescuit/) and
emails subscribers when spots open up.

## Overview

Every hour, on the hour, the Worker fetches the reservations page, parses
each pontoon's calendar table from the rendered HTML, filters to the current
week (Mon–Sun in `Europe/Bucharest`), and compares against the previous
tick's snapshot stored in Cloudflare KV. Anything newly available since the
last check produces an email — one per recipient, sent natively through the
Cloudflare Email Workers binding from `rezervari-pescuit@claudiu.dev`. If
nothing is new, the run is silent and just refreshes the snapshot.

State lives in a single KV namespace, two keys:

- `recipients` — JSON array of email addresses, hot-editable without redeploy.
- `snapshot` — the previous-tick set of `(calId, date)` slots.

The system fails closed: a non-zero parse and at least one successful send
are required before the snapshot advances, so transient outages don't drop
openings.

### Sample email

**Subject:**

```
Valcroft: 12 locuri noi săptămâna aceasta
```

**Body** (from a real run on 2026-05-01):

```
Locuri noi disponibile săptămâna aceasta:

Ponton 11 — dum 3 mai
Ponton 20 — dum 3 mai
Ponton 33 — dum 3 mai
Ponton 37 — dum 3 mai
Ponton 38 — dum 3 mai
Ponton 39 — dum 3 mai
Ponton 40 — dum 3 mai
Ponton 41 — dum 3 mai
Ponton 42 — dum 3 mai
Ponton 44 — dum 3 mai
Ponton 45 — dum 3 mai
Ponton 52 — dum 3 mai

Rezervă acum
```

Sent from `rezervari-pescuit@claudiu.dev` so you can build a gmail filter on
the `From:` address.

For the why-it's-built-this-way and the operational backlog, see the
documentation links at the bottom of this file.

## Setup

1. Enable Email Routing on a domain in your CF account, set `SENDER_EMAIL` in `wrangler.jsonc`.
2. Verify each personal address as an Email Routing destination address.
3. `npx wrangler kv namespace create KV` → paste the `id` into `wrangler.jsonc`.
4. `npx wrangler kv key put --binding=KV --remote recipients '["you@example.com"]'`.
5. `npm run deploy`.

## Operations

```sh
# Tail live production logs
npm run tail

# Local end-to-end smoke test against production KV + Email
npm run dev:remote
# ... then: curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"

# Add or change recipients (no redeploy)
npx wrangler kv key put --binding=KV --remote recipients '["a@example.com","b@example.com"]'

# Force the next tick to re-emit every currently-available slot
# (useful after changing the sender to seed an inbox filter, or to recover state)
npx wrangler kv key delete --binding=KV --remote snapshot

# Regenerate the Env type after editing bindings in wrangler.jsonc
npx wrangler types
```

A new recipient must first be verified as an Email Routing destination address
on the sender domain (CF dashboard → your-domain → Email → Email Routing →
Destination addresses → add → click verification email).

## Documentation

- [`docs/plans/2026-05-01-availability-notifier-design.md`](docs/plans/2026-05-01-availability-notifier-design.md) — design rationale.
- [`docs/plans/2026-05-01-availability-notifier-plan.md`](docs/plans/2026-05-01-availability-notifier-plan.md) — task-by-task implementation plan.
- [`docs/plans/2026-05-01-availability-notifier-summary.md`](docs/plans/2026-05-01-availability-notifier-summary.md) — v1 summary, decisions, and backlog.
