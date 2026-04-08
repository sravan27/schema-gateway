# Schema Gateway

`Schema Gateway` is a machine-to-machine API for one of the loudest integration failures in current AI stacks: provider-specific structured output drift. The codebase includes:

- a free SDK for local schema validation and tool-call normalization
- a Cloudflare Worker for paid, signed normalization responses
- a Solidity paywall contract that accepts native or ERC-20 payments and emits receipts the Worker can redeem into API keys
- a Polar billing path for legal fiat checkout and API-key provisioning

## Why this wedge

The product choice is based on current merged PR and research signals from March 9, 2026 through April 8, 2026:

- OpenAI SDK release rollups repeatedly ship response type alignment and structured output fixes: [openai/openai-node#1781](https://github.com/openai/openai-node/pull/1781), [openai/openai-python#2995](https://github.com/openai/openai-python/pull/2995)
- LangChain is still landing provider-specific `response_format` compatibility fixes: [langchain-ai/langchain#34612](https://github.com/langchain-ai/langchain/pull/34612)
- Enterprise infra repos keep adding fail-fast validation, retries, and async race protection: [cloudflare/workers-sdk#13314](https://github.com/cloudflare/workers-sdk/pull/13314), [microsoft/TypeScript#63368](https://github.com/microsoft/TypeScript/pull/63368), [kubernetes/kubernetes#138059](https://github.com/kubernetes/kubernetes/pull/138059)
- Recent research points the same way: tool discovery, retry loops, routing, schema-aware outputs, and auditable agents are active areas of work: [Semantic Tool Discovery for Large Language Models](https://arxiv.org/abs/2603.20313), [Try, Check and Retry](https://arxiv.org/abs/2603.11495), [ESAinsTOD](https://arxiv.org/abs/2603.09691), [Auditable Agents](https://arxiv.org/abs/2604.05485)

## Packages

- `packages/core`: schema extraction, coercion, validation, signatures, and receipt helpers
- `packages/sdk`: the free open-source upgrade path
- `packages/worker`: the paid edge API
- `packages/contracts`: the Solidity paywall and deterministic deployment tooling

## API Surface

The Worker exposes a machine-readable spec at `/openapi.json`, making the paid API easy to wire into other services and agent runtimes.

## Billing Paths

The project now supports two paid access paths:

- `Polar`: legal fiat checkout for customers, with a webhook that provisions a claimable API key after `order.paid`
- `On-chain paywall`: deterministic smart-contract purchase receipts for crypto-native access

## Local usage

```bash
npm install
npm run build
npm test
npm run bench
```

## Free SDK and paid upgrade

Use the free SDK locally first:

```ts
import { SchemaGatewayClient } from "@apex-value/schema-gateway";

const client = new SchemaGatewayClient();
const result = await client.normalizeLocal({
  schema,
  payload
});
```

Or use the CLI:

```bash
schema-gateway validate --schema ./schema.json --payload ./payload.json
schema-gateway commitment --label router-service
```

Provider-specific examples live in:

- `/Users/sravansridhar/Documents/auto-money/examples/openai-responses.ts`
- `/Users/sravansridhar/Documents/auto-money/examples/langchain-ollama.ts`

When you need signed responses and prepaid credits, generate the same label commitment locally, buy credits on-chain with that commitment, then redeem the resulting transaction for a key:

```ts
import { buildPurchaseMetadata, SchemaGatewayClient } from "@apex-value/schema-gateway";

const { keyCommitment } = await buildPurchaseMetadata("router-service");
// Submit `keyCommitment` to the paywall contract, then:
const gateway = new SchemaGatewayClient({ baseUrl: "https://your-worker.example" });
const access = await gateway.redeemCredits({
  txHash,
  label: "router-service"
});
```

For the fiat billing path, configure `POLAR_WEBHOOK_SECRET` and point Polar webhooks at `/v1/webhooks/polar`. After checkout, a customer can claim their issued API key with:

```bash
curl -X POST https://your-worker.example/v1/access/polar/claim \
  -H 'content-type: application/json' \
  -d '{"orderId":"<polar-order-id>","email":"customer@example.com"}'
```

For the shortest launch path, see [docs/revenue-playbook.md](/Users/sravansridhar/Documents/auto-money/docs/revenue-playbook.md).

Run the Worker locally:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Compile the contract:

```bash
npm run compile:contracts
```

Dry-run the deterministic deployment script:

```bash
npm run deploy:dry-run -w packages/contracts
```

## Compliance note

This repository implements a prepaid API-credit mechanism. Real deployment still requires jurisdiction-specific legal review, treasury control, and any tax or licensing work your operating entity needs.
