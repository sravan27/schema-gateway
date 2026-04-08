import {
  buildLabelCommitment,
  constantTimeEqual,
  createSignedEnvelope,
  lintStructuredOutputSchema,
  normalizeStructuredOutput,
  purchaseEventAbiItem,
  randomToken,
  sha256Hex,
  withRetry,
  type ApiKeyRecord,
  type PurchaseEventPayload,
  type SchemaPortabilityTarget
} from "@apex-value/schema-gateway-core";
import { WebhookVerificationError, validateEvent } from "@polar-sh/sdk/webhooks";
import { Hono, type MiddlewareHandler } from "hono";
import { decodeEventLog } from "viem";
import { ZodError, z } from "zod";

import { openApiDocument } from "./openapi.js";

type Bindings = {
  ACCESS_TTL_SECONDS?: string;
  ALLOW_EPHEMERAL_STORAGE?: string;
  API_KEYS?: KVNamespace;
  CHECKOUT_URL?: string;
  CONTRACT_ADDRESS?: string;
  ISSUER_SECRET: string;
  POLAR_CLAIMS?: KVNamespace;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_ACCESS_TTL_SECONDS?: string;
  POLAR_PRODUCT_ID?: string;
  POLAR_WEBHOOK_SECRET?: string;
  PUBLIC_CONTACT_EMAIL?: string;
  REDEMPTIONS?: KVNamespace;
  RPC_URL?: string;
};

type Variables = {
  accessPayload?: StatelessAccessPayload;
  keyId: string;
  keyRecord: ApiKeyRecord;
};

const memoryKeys = new Map<string, ApiKeyRecord>();
const memoryPolarClaims = new Map<string, PolarClaimRecord>();
const memoryRedemptions = new Set<string>();

const NormalizeBodySchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  payload: z.unknown(),
  provider: z.enum(["generic", "openai", "langchain", "ollama"]).optional()
});

const LintBodySchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  targets: z.array(z.enum(["openai", "gemini", "anthropic", "ollama"])).optional()
});

const RedeemBodySchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  label: z.string().min(3).max(64),
  chainId: z.number().int().positive().optional()
});

const PolarClaimBodySchema = z.object({
  orderId: z.string().min(1),
  email: z.string().email()
});

interface PolarOrderPaidEvent {
  type: "order.paid";
  timestamp: string;
  data: {
    id: string;
    product_id?: string | null;
    total_amount?: number;
    currency?: string;
    customer?: {
      email?: string | null;
      name?: string | null;
      external_id?: string | null;
    } | null;
    product?: {
      id?: string | null;
      name?: string | null;
    } | null;
  };
}

interface PolarClaimRecord {
  orderId: string;
  email: string;
  apiKey: string;
  keyId: string;
  credits: number;
  issuedAt: string;
  productId?: string;
  productName?: string;
}

interface PolarOrderRecord {
  id: string;
  productId?: string;
  productName?: string;
  customerEmail?: string;
  billingName?: string;
  status?: string;
}

interface StatelessAccessPayload {
  type: "polar_access";
  orderId: string;
  email: string;
  issuedAt: string;
  expiresAt: string;
  productId?: string;
  productName?: string;
}

type StorageBindingName = "API_KEYS" | "POLAR_CLAIMS" | "REDEMPTIONS";

class StorageConfigurationError extends Error {
  constructor(missingBindings: StorageBindingName[]) {
    const joined = missingBindings.join(", ");
    super(
      `Persistent storage is required for this route. Missing Cloudflare KV binding(s): ${joined}. Bind them in Wrangler, or set ALLOW_EPHEMERAL_STORAGE=true for local development only.`
    );
    this.name = "StorageConfigurationError";
  }
}

function getTtlSeconds(env: Bindings): number {
  const parsed = Number.parseInt(env.ACCESS_TTL_SECONDS ?? "86400", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86400;
}

function getPolarAccessTtlSeconds(env: Bindings): number {
  const parsed = Number.parseInt(env.POLAR_ACCESS_TTL_SECONDS ?? "2592000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2592000;
}

function allowsEphemeralStorage(env: Bindings): boolean {
  return env.ALLOW_EPHEMERAL_STORAGE === "true";
}

function assertPersistentStorage(
  env: Bindings,
  requiredBindings: StorageBindingName[]
): void {
  if (allowsEphemeralStorage(env)) {
    return;
  }

  const bindings = {
    API_KEYS: env.API_KEYS,
    POLAR_CLAIMS: env.POLAR_CLAIMS,
    REDEMPTIONS: env.REDEMPTIONS
  } satisfies Record<StorageBindingName, KVNamespace | undefined>;
  const missingBindings = requiredBindings.filter((binding) => !bindings[binding]);

  if (missingBindings.length > 0) {
    throw new StorageConfigurationError(missingBindings);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function renderLandingPage(context: {
  baseUrl: string;
  checkoutUrl: string | undefined;
  contactEmail: string | undefined;
}): string {
  const checkoutMarkup = context.checkoutUrl
    ? `<a class="primary" href="${escapeHtml(context.checkoutUrl)}">Buy prepaid credits</a>`
    : `<span class="badge">Checkout link available after billing is configured</span>`;
  const contactMarkup = context.contactEmail
    ? `<p class="meta">Support: <a href="mailto:${escapeHtml(context.contactEmail)}">${escapeHtml(context.contactEmail)}</a></p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Schema Gateway Pro</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe5;
        --panel: #fffdf8;
        --ink: #172126;
        --muted: #54616b;
        --accent: #0f766e;
        --accent-ink: #f6fffd;
        --border: #d8d2c7;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top right, rgba(15, 118, 110, 0.12), transparent 30%),
          linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
        color: var(--ink);
      }
      main {
        max-width: 880px;
        margin: 0 auto;
        padding: 56px 20px 80px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 14px 50px rgba(23, 33, 38, 0.08);
      }
      .eyebrow, .badge, .meta {
        color: var(--muted);
        font-size: 0.95rem;
      }
      h1 {
        margin: 10px 0 14px;
        font-size: clamp(2.3rem, 6vw, 4.4rem);
        line-height: 0.98;
        letter-spacing: -0.04em;
      }
      p {
        font-size: 1.08rem;
        line-height: 1.65;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 28px 0 6px;
      }
      .primary, .secondary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 48px;
        border-radius: 999px;
        padding: 0 18px;
        text-decoration: none;
        font-weight: 600;
      }
      .primary {
        background: var(--accent);
        color: var(--accent-ink);
      }
      .secondary {
        border: 1px solid var(--border);
        color: var(--ink);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 14px;
        margin-top: 28px;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
        background: rgba(255, 255, 255, 0.7);
      }
      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 0.95em;
      }
      ul {
        margin: 10px 0 0;
        padding-left: 18px;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <div class="eyebrow">Machine-to-machine AI infrastructure</div>
        <h1>Schema Gateway Pro</h1>
        <p>
          Schema Gateway is a developer API that normalizes and validates structured LLM outputs
          and tool-call payloads across providers. Teams use it to reduce provider drift, lint
          one schema against multiple vendors, sign normalized responses, and gate production
          traffic behind paid access keys.
        </p>
        <div class="actions">
          ${checkoutMarkup}
          <a class="secondary" href="${escapeHtml(context.baseUrl)}/openapi.json">OpenAPI spec</a>
        </div>
        <p class="meta">Base URL: <code>${escapeHtml(context.baseUrl)}</code></p>
        ${contactMarkup}
        <div class="grid">
          <article class="card">
            <strong>Paid API</strong>
            <ul>
              <li><code>POST /v1/normalize</code></li>
              <li><code>POST /v1/access/polar/claim</code></li>
              <li><code>POST /v1/access/redeem</code></li>
            </ul>
          </article>
          <article class="card">
            <strong>Compliance</strong>
            <p class="meta">
              This is prepaid API software. It does not provide financial services, money
              transmission, KYC, investing, or outreach automation.
            </p>
          </article>
          <article class="card">
            <strong>Upgrade path</strong>
            <p class="meta">
              Start with the open-source SDK, then move to signed responses, portability linting,
              and paid shared access when you need production enforcement.
            </p>
          </article>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

async function readKeyRecord(env: Bindings, keyId: string): Promise<ApiKeyRecord | null> {
  if (env.API_KEYS) {
    const record = await env.API_KEYS.get(`key:${keyId}`, "json");
    return record as ApiKeyRecord | null;
  }

  return memoryKeys.get(keyId) ?? null;
}

async function writeKeyRecord(env: Bindings, record: ApiKeyRecord): Promise<void> {
  if (env.API_KEYS) {
    await env.API_KEYS.put(`key:${record.keyId}`, JSON.stringify(record), {
      expirationTtl: getTtlSeconds(env)
    });
    return;
  }

  memoryKeys.set(record.keyId, record);
}

async function readPolarClaim(env: Bindings, orderId: string): Promise<PolarClaimRecord | null> {
  if (env.POLAR_CLAIMS) {
    const record = await env.POLAR_CLAIMS.get(`polar-claim:${orderId}`, "json");
    return record as PolarClaimRecord | null;
  }

  return memoryPolarClaims.get(orderId) ?? null;
}

async function writePolarClaim(env: Bindings, record: PolarClaimRecord): Promise<void> {
  if (env.POLAR_CLAIMS) {
    await env.POLAR_CLAIMS.put(`polar-claim:${record.orderId}`, JSON.stringify(record), {
      expirationTtl: getTtlSeconds(env)
    });
    return;
  }

  memoryPolarClaims.set(record.orderId, record);
}

async function hasRedemption(env: Bindings, marker: string): Promise<boolean> {
  if (env.REDEMPTIONS) {
    return (await env.REDEMPTIONS.get(`redeemed:${marker}`)) !== null;
  }

  return memoryRedemptions.has(marker);
}

async function markRedemption(env: Bindings, marker: string): Promise<void> {
  if (env.REDEMPTIONS) {
    await env.REDEMPTIONS.put(`redeemed:${marker}`, "1", {
      expirationTtl: getTtlSeconds(env)
    });
    return;
  }

  memoryRedemptions.add(marker);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isStatelessPolarMode(env: Bindings): boolean {
  return typeof env.POLAR_ACCESS_TOKEN === "string" && env.POLAR_ACCESS_TOKEN.length > 0;
}

function extractApiKey(rawHeaderValue: string | undefined): string | null {
  if (!rawHeaderValue) {
    return null;
  }

  if (rawHeaderValue.toLowerCase().startsWith("bearer ")) {
    return rawHeaderValue.slice("bearer ".length).trim();
  }

  return rawHeaderValue.trim();
}

async function fetchPolarOrder(env: Bindings, orderId: string): Promise<PolarOrderRecord | null> {
  if (!env.POLAR_ACCESS_TOKEN) {
    throw new Error("POLAR_ACCESS_TOKEN is not configured.");
  }

  const response = await withRetry(async () => {
    const result = await fetch(`https://api.polar.sh/v1/orders/${orderId}`, {
      headers: {
        Authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`
      }
    });

    if (!result.ok) {
      if (result.status === 404) {
        return result;
      }

      throw new Error(`Polar returned ${result.status} while loading order ${orderId}.`);
    }

    return result;
  });

  if (response.status === 404) {
    return null;
  }

  const payload = (await response.json()) as {
    id?: string;
    status?: string;
    product_id?: string | null;
    customer?: {
      email?: string | null;
      name?: string | null;
    } | null;
    product?: {
      id?: string | null;
      name?: string | null;
    } | null;
    billing_name?: string | null;
  };

  if (!payload.id) {
    throw new Error("Polar order lookup returned an invalid payload.");
  }

  const productId = payload.product_id ?? payload.product?.id ?? null;
  const billingName = payload.billing_name ?? payload.customer?.name ?? null;

  return {
    id: payload.id,
    ...(payload.status ? { status: payload.status } : {}),
    ...(productId ? { productId } : {}),
    ...(payload.product?.name ? { productName: payload.product.name } : {}),
    ...(payload.customer?.email ? { customerEmail: payload.customer.email } : {}),
    ...(billingName ? { billingName } : {})
  };
}

async function issueStatelessPolarAccessKey(
  env: Bindings,
  order: PolarOrderRecord,
  email: string
): Promise<{
  apiKey: string;
  orderId: string;
  email: string;
  issuedAt: string;
  expiresAt: string;
  productId?: string;
  productName?: string;
}> {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + getPolarAccessTtlSeconds(env) * 1000).toISOString();
  const payload: StatelessAccessPayload = {
    type: "polar_access",
    orderId: order.id,
    email: normalizeEmail(email),
    issuedAt,
    expiresAt,
    ...(order.productId ? { productId: order.productId } : {}),
    ...(order.productName ? { productName: order.productName } : {})
  };
  const tokenPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await createSignedEnvelope(env.ISSUER_SECRET, payload);
  const apiKey = `sk_live.access.${tokenPayload}.${signature.slice(2)}`;

  return {
    apiKey,
    orderId: order.id,
    email: payload.email,
    issuedAt,
    expiresAt,
    ...(order.productId ? { productId: order.productId } : {}),
    ...(order.productName ? { productName: order.productName } : {})
  };
}

async function verifyStatelessPolarAccessKey(
  env: Bindings,
  providedKey: string
): Promise<StatelessAccessPayload | null> {
  const parts = providedKey.split(".");
  if (parts.length !== 4 || parts[0] !== "sk_live" || parts[1] !== "access") {
    return null;
  }

  const payloadToken = parts[2];
  const signatureToken = parts[3];
  if (!payloadToken || !signatureToken) {
    return null;
  }

  let payload: StatelessAccessPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadToken)) as StatelessAccessPayload;
  } catch {
    return null;
  }

  if (payload.type !== "polar_access" || !payload.orderId || !payload.email || !payload.expiresAt) {
    return null;
  }

  const expectedSignature = await createSignedEnvelope(env.ISSUER_SECRET, payload);
  if (!constantTimeEqual(expectedSignature.slice(2), signatureToken)) {
    return null;
  }

  if (Number.isNaN(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()) {
    throw new Error("This access key has expired. Re-claim access from your Polar order.");
  }

  return payload;
}

async function issueApiKey(
  env: Bindings,
  label: string,
  txHash: `0x${string}`,
  credits: bigint
): Promise<{
  apiKey: string;
  keyId: string;
  credits: number;
  signature: `0x${string}`;
  label: string;
}> {
  if (credits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Credit value exceeds JavaScript's safe integer range.");
  }

  const keyId = randomToken(9);
  const apiKey = `sk_live.${keyId}.${randomToken(24)}`;
  const issuedAt = new Date().toISOString();
  const signature = await createSignedEnvelope(env.ISSUER_SECRET, {
    keyId,
    label,
    txHash,
    credits: Number(credits),
    issuedAt
  });

  const record: ApiKeyRecord = {
    keyId,
    label,
    hashedKey: await sha256Hex(apiKey),
    credits: Number(credits),
    issuedAt,
    txHash,
    signature
  };

  await writeKeyRecord(env, record);

  return {
    apiKey,
    keyId,
    credits: record.credits,
    signature,
    label
  };
}

async function issuePolarClaim(
  env: Bindings,
  orderId: string,
  email: string,
  productId?: string,
  productName?: string
): Promise<PolarClaimRecord> {
  const keyId = randomToken(9);
  const apiKey = `sk_live.${keyId}.${randomToken(24)}`;
  const issuedAt = new Date().toISOString();

  const record: ApiKeyRecord = {
    keyId,
    label: productName ?? "Polar purchase",
    hashedKey: await sha256Hex(apiKey),
    credits: 1000,
    issuedAt,
    signature: await createSignedEnvelope(env.ISSUER_SECRET, {
      keyId,
      orderId,
      email: normalizeEmail(email),
      issuedAt
    }),
    txHash: `0x${"0".repeat(64)}`
  };

  await writeKeyRecord(env, record);

  const claim: PolarClaimRecord = {
    orderId,
    email: normalizeEmail(email),
    apiKey,
    keyId,
    credits: record.credits,
    issuedAt,
    ...(productId ? { productId } : {}),
    ...(productName ? { productName } : {})
  };

  await writePolarClaim(env, claim);
  return claim;
}

async function spendCredit(env: Bindings, record: ApiKeyRecord): Promise<ApiKeyRecord> {
  if (record.keyId.startsWith("polar:")) {
    return {
      ...record,
      lastUsedAt: new Date().toISOString()
    };
  }

  const updatedRecord: ApiKeyRecord = {
    ...record,
    credits: record.credits - 1,
    lastUsedAt: new Date().toISOString()
  };

  await writeKeyRecord(env, updatedRecord);
  return updatedRecord;
}

async function loadPurchaseEvent(
  env: Bindings,
  txHash: `0x${string}`,
  label: string
): Promise<PurchaseEventPayload> {
  if (!env.RPC_URL || !env.CONTRACT_ADDRESS) {
    throw new Error("RPC_URL and CONTRACT_ADDRESS must be configured to redeem receipts.");
  }

  const expectedCommitment = await buildLabelCommitment(label);
  const receiptPayload = await withRetry(async () => {
    const receiptResponse = await fetch(env.RPC_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [txHash]
      })
    });

    if (!receiptResponse.ok) {
      throw new Error(`RPC returned ${receiptResponse.status} while loading the receipt.`);
    }

    return (await receiptResponse.json()) as {
      error?: { message?: string };
      result?: {
        logs?: Array<{
          address: string;
          data: `0x${string}`;
          topics: `0x${string}`[];
        }>;
      };
    };
  });

  if (receiptPayload.error) {
    throw new Error(receiptPayload.error.message ?? "RPC returned an unknown error.");
  }

  const logs = receiptPayload.result?.logs ?? [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== env.CONTRACT_ADDRESS.toLowerCase()) {
      continue;
    }

    if (log.topics.length === 0) {
      continue;
    }

    const decoded = decodeEventLog({
      abi: [purchaseEventAbiItem],
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      strict: false
    });

    if (decoded.eventName !== "Purchase") {
      continue;
    }

    const args = decoded.args as {
      buyer?: `0x${string}`;
      token?: `0x${string}`;
      amount?: bigint;
      credits?: bigint;
      keyCommitment?: `0x${string}`;
    };

    if (!args.keyCommitment || args.keyCommitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
      continue;
    }

    if (!args.buyer || !args.token || args.amount === undefined || args.credits === undefined) {
      continue;
    }

    return {
      buyer: args.buyer,
      token: args.token,
      amount: args.amount,
      credits: args.credits,
      keyCommitment: args.keyCommitment,
      txHash
    };
  }

  throw new Error("No matching Purchase event was found for the supplied label commitment.");
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.onError((error, context) => {
  if (error instanceof ZodError) {
    return context.json(
      {
        error: "Invalid request body.",
        issues: error.flatten()
      },
      400
    );
  }

  if (error instanceof StorageConfigurationError) {
    return context.json(
      {
        error: error.message
      },
      503
    );
  }

  return context.json(
    {
      error: error.message
    },
    500
  );
});

app.get("/", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.html(
    renderLandingPage({
      baseUrl,
      checkoutUrl: context.env.CHECKOUT_URL,
      contactEmail: context.env.PUBLIC_CONTACT_EMAIL
    })
  );
});

app.get("/health", (context) => {
  return context.json({
    ok: true,
    storage: context.env.API_KEYS ? "kv" : "memory",
    ephemeralStorageAllowed: allowsEphemeralStorage(context.env)
  });
});

app.get("/openapi.json", (context) => {
  return context.json(openApiDocument);
});

app.post("/v1/webhooks/polar", async (context) => {
  if (isStatelessPolarMode(context.env) && !context.env.POLAR_WEBHOOK_SECRET) {
    return context.json(
      {
        ok: true,
        ignored: true,
        mode: "stateless-polar-claim"
      },
      202
    );
  }

  assertPersistentStorage(context.env, ["API_KEYS", "POLAR_CLAIMS", "REDEMPTIONS"]);

  const webhookSecret = context.env.POLAR_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return context.json(
      {
        error: "POLAR_WEBHOOK_SECRET is not configured."
      },
      500
    );
  }

  const body = await context.req.text();

  let event: PolarOrderPaidEvent;
  try {
    const headers = Object.fromEntries(context.req.raw.headers.entries());
    event = validateEvent(body, headers, webhookSecret) as unknown as PolarOrderPaidEvent;
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return context.json(
        {
          error: "Invalid webhook signature."
        },
        403
      );
    }

    throw error;
  }

  if (event.type !== "order.paid") {
    return context.json(
      {
        ok: true,
        ignored: true
      },
      202
    );
  }

  const productId = event.data.product_id ?? event.data.product?.id ?? undefined;
  const requiredProductId = context.env.POLAR_PRODUCT_ID;
  if (requiredProductId && productId && productId !== requiredProductId) {
    return context.json(
      {
        ok: true,
        ignored: true
      },
      202
    );
  }

  const email = event.data.customer?.email;
  if (!email) {
    return context.json(
      {
        error: "Paid order webhook does not include a customer email."
      },
      422
    );
  }

  const marker = `polar:${event.data.id}`;
  if (await hasRedemption(context.env, marker)) {
    return context.json(
      {
        ok: true,
        duplicate: true
      },
      202
    );
  }

  const claim = await issuePolarClaim(
    context.env,
    event.data.id,
    email,
    productId,
    event.data.product?.name ?? undefined
  );
  await markRedemption(context.env, marker);

  return context.json(
    {
      ok: true,
      orderId: claim.orderId,
      keyId: claim.keyId
    },
    202
  );
});

app.post("/v1/access/redeem", async (context) => {
  assertPersistentStorage(context.env, ["API_KEYS", "REDEMPTIONS"]);
  const body = RedeemBodySchema.parse(await context.req.json());

  if (await hasRedemption(context.env, body.txHash as `0x${string}`)) {
    return context.json(
      {
        error: "This transaction hash has already been redeemed."
      },
      409
    );
  }

  const purchase = await loadPurchaseEvent(
    context.env,
    body.txHash as `0x${string}`,
    body.label
  );

  await markRedemption(context.env, purchase.txHash);
  const issued = await issueApiKey(context.env, body.label, purchase.txHash, purchase.credits);

  return context.json(issued, 201);
});

app.post("/v1/access/polar/claim", async (context) => {
  const body = PolarClaimBodySchema.parse(await context.req.json());

  if (isStatelessPolarMode(context.env)) {
    const order = await fetchPolarOrder(context.env, body.orderId);
    if (!order) {
      return context.json(
        {
          error: "No Polar order was found for that order ID."
        },
        404
      );
    }

    const expectedEmail = order.customerEmail ? normalizeEmail(order.customerEmail) : null;
    if (!expectedEmail || expectedEmail !== normalizeEmail(body.email)) {
      return context.json(
        {
          error: "The email does not match the paid Polar order."
        },
        403
      );
    }

    if (order.status && !["paid", "confirmed", "succeeded"].includes(order.status.toLowerCase())) {
      return context.json(
        {
          error: `Polar order ${body.orderId} is not in a paid state.`
        },
        409
      );
    }

    const requiredProductId = context.env.POLAR_PRODUCT_ID;
    if (requiredProductId && order.productId && order.productId !== requiredProductId) {
      return context.json(
        {
          error: "That order does not match the configured product."
        },
        403
      );
    }

    const access = await issueStatelessPolarAccessKey(context.env, order, body.email);
    return context.json({
      ...access,
      accessMode: "stateless"
    });
  }

  assertPersistentStorage(context.env, ["POLAR_CLAIMS"]);
  const claim = await readPolarClaim(context.env, body.orderId);

  if (!claim) {
    return context.json(
      {
        error: "No Polar claim was found for that order ID."
      },
      404
    );
  }

  if (normalizeEmail(claim.email) !== normalizeEmail(body.email)) {
    return context.json(
      {
        error: "The email does not match the order."
      },
      403
    );
  }

  return context.json({
    orderId: claim.orderId,
    email: claim.email,
    apiKey: claim.apiKey,
    keyId: claim.keyId,
    credits: claim.credits,
    issuedAt: claim.issuedAt,
    productId: claim.productId,
    productName: claim.productName
  });
});

const requireApiKey: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (
  context,
  next
) => {
  const providedKey =
    extractApiKey(context.req.header("x-api-key")) ??
    extractApiKey(context.req.header("authorization"));

  if (!providedKey) {
    return context.json(
      {
        error: "An API key is required."
      },
      401
    );
  }

  if (!providedKey.startsWith("sk_live.")) {
    return context.json(
      {
        error: "The API key format is invalid."
      },
      401
    );
  }

  const statelessPayload = await verifyStatelessPolarAccessKey(context.env, providedKey);
  if (statelessPayload) {
    context.set("accessPayload", statelessPayload);
    context.set("keyId", `polar:${statelessPayload.orderId}`);
    context.set("keyRecord", {
      keyId: `polar:${statelessPayload.orderId}`,
      label: statelessPayload.productName ?? "Polar access",
      hashedKey: await sha256Hex(providedKey),
      credits: Number.MAX_SAFE_INTEGER,
      issuedAt: statelessPayload.issuedAt,
      lastUsedAt: statelessPayload.expiresAt,
      txHash: `0x${"0".repeat(64)}`,
      signature: await createSignedEnvelope(context.env.ISSUER_SECRET, statelessPayload)
    });
    await next();
    return;
  }

  assertPersistentStorage(context.env, ["API_KEYS"]);
  const parts = providedKey.split(".");
  const keyId = parts[1];
  if (!keyId) {
    return context.json(
      {
        error: "The API key format is invalid."
      },
      401
    );
  }

  const record = await readKeyRecord(context.env, keyId);
  if (!record) {
    return context.json(
      {
        error: "The supplied API key was not found."
      },
      401
    );
  }

  const hashedKey = await sha256Hex(providedKey);
  if (!constantTimeEqual(record.hashedKey, hashedKey)) {
    return context.json(
      {
        error: "The supplied API key is not valid."
      },
      401
    );
  }

  if (record.credits < 1) {
    return context.json(
      {
        error: "This API key has no credits left."
      },
      402
    );
  }

  context.set("keyId", keyId);
  context.set("keyRecord", record);

  await next();
};

app.use("/v1/normalize", requireApiKey);
app.use("/v1/lint", requireApiKey);

app.post("/v1/normalize", async (context) => {
  const body = NormalizeBodySchema.parse(await context.req.json());
  const accessPayload = context.get("accessPayload");
  const keyId = context.get("keyId");
  const record = context.get("keyRecord");
  const result = await normalizeStructuredOutput({
    schema: body.schema,
    payload: body.payload,
    ...(body.provider ? { provider: body.provider } : {})
  });

  const updatedRecord = await spendCredit(context.env, record);

  const signature = await createSignedEnvelope(context.env.ISSUER_SECRET, {
    keyId,
    schemaHash: result.schemaHash,
    normalized: result.normalized,
    remainingCredits: accessPayload ? null : updatedRecord.credits,
    expiresAt: accessPayload?.expiresAt
  });

  return context.json({
    ...result,
    remainingCredits: accessPayload ? null : updatedRecord.credits,
    signature,
    ...(accessPayload
      ? {
          accessMode: "stateless",
          expiresAt: accessPayload.expiresAt
        }
      : {})
  });
});

app.post("/v1/lint", async (context) => {
  const body = LintBodySchema.parse(await context.req.json());
  const accessPayload = context.get("accessPayload");
  const keyId = context.get("keyId");
  const record = context.get("keyRecord");
  const report = await lintStructuredOutputSchema({
    schema: body.schema,
    ...(body.targets ? { targets: body.targets as SchemaPortabilityTarget[] } : {})
  });
  const updatedRecord = await spendCredit(context.env, record);

  const signature = await createSignedEnvelope(context.env.ISSUER_SECRET, {
    keyId,
    schemaHash: report.schemaHash,
    providers: report.providers.map((provider) => ({
      provider: provider.provider,
      compatible: provider.compatible,
      score: provider.score
    })),
    remainingCredits: accessPayload ? null : updatedRecord.credits,
    expiresAt: accessPayload?.expiresAt
  });

  return context.json({
    ...report,
    remainingCredits: accessPayload ? null : updatedRecord.credits,
    signature,
    ...(accessPayload
      ? {
          accessMode: "stateless",
          expiresAt: accessPayload.expiresAt
        }
      : {})
  });
});

export type { Bindings };
export { app };
export default app;
