# valcroft-availability-notifier

A Cloudflare Worker that monitors fishing-pontoon availability on
[valcroft.ro/rezervari-pescuit](https://valcroft.ro/rezervari-pescuit/) and
emails subscribers when spots open up.

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
