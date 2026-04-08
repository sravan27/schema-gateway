# Revenue Playbook

This repo cannot guarantee revenue on its own, but it is now set up to support a fast, low-touch launch around a real integration pain: structured output compatibility across model providers and agent frameworks.

## Shortest path

1. Publish the free packages.

```bash
npm publish -w packages/core --access public
npm publish -w packages/sdk --access public
```

2. Deploy the Cloudflare Worker with real secrets.

```bash
wrangler secret put ISSUER_SECRET
wrangler secret put POLAR_ACCESS_TOKEN
wrangler secret put CHECKOUT_URL
wrangler secret put PUBLIC_CONTACT_EMAIL
wrangler deploy
```

For the lowest-friction launch, use the stateless Polar access path. It verifies a paid Polar order live and issues a signed time-boxed access key without relying on Cloudflare KV.

If you want durable prepaid credits instead, add Cloudflare KV and the webhook-backed flow:

```bash
wrangler kv namespace create API_KEYS
wrangler kv namespace create POLAR_CLAIMS
wrangler kv namespace create REDEMPTIONS
wrangler secret put POLAR_WEBHOOK_SECRET
wrangler secret put RPC_URL
wrangler secret put CONTRACT_ADDRESS
```

3. Broadcast the paywall contract with real owner, treasury, and pricing values.

```bash
RPC_URL=... PRIVATE_KEY=... OWNER_ADDRESS=... TREASURY_ADDRESS=... \
NATIVE_UNITS_PER_CREDIT=100000000000000 \
npm run deploy:dry-run -w packages/contracts
```

Remove `--dry-run` when you are ready to send the transaction.

4. Set an intentionally simple first price.

- Free: unlimited local CLI and SDK use
- Paid: signed remote normalization with prepaid credits
- Suggested first paid offer: a low-friction one-time Polar starter pack in INR for initial access credits

5. Put the free tool where developers already look.

- npm README examples
- a GitHub repository with copy-paste examples
- small benchmark examples showing malformed provider output becoming valid JSON

## Conversion hook

The free package should solve the local 80% case:

- schema validation
- JSON repair
- tool-call argument extraction
- basic coercion
- schema portability linting across OpenAI, Gemini, Anthropic, and Ollama

The paid Worker should be the 20% upsell:

- signed normalization receipts
- signed schema portability reports for CI and release gates
- stateless paid access keys claimed from a Polar order, or prepaid key issuance from a Polar webhook / on-chain purchase event
- remote access for shared services and production pipelines
- centralized observability once you add analytics bindings

## Immediate offer

Sell this as infrastructure, not an app:

- “Normalize provider drift before it breaks your agent pipeline.”
- “Turn malformed tool outputs into schema-valid JSON with signatures.”
- “Keep local validation free, pay only for shared production enforcement.”

## What to add next

- a tiny benchmark corpus with real before/after payloads
- request logging and usage analytics in the Worker
- one blog post or README section per provider quirk you already handle
- one example integration for LangChain and one for OpenAI Responses API
