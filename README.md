# valcroft-availability-notifier

A Cloudflare Worker that monitors fishing-pontoon availability on
[valcroft.ro/rezervari-pescuit](https://valcroft.ro/rezervari-pescuit/) and
emails subscribers when spots open up.

## Setup

1. Enable Email Routing on a domain in your CF account, set `SENDER_EMAIL` in `wrangler.jsonc`.
2. Verify each personal address as an Email Routing destination address.
3. `wrangler kv namespace create KV` → paste the `id` into `wrangler.jsonc`.
4. `wrangler kv key put --binding=KV recipients '["you@example.com"]'`.
5. `npm run deploy`.
