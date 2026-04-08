import {
  buildLabelCommitment,
  constantTimeEqual,
  createSignedEnvelope,
  normalizeStructuredOutput,
  purchaseEventAbiItem,
  randomToken,
  sha256Hex,
  withRetry,
  type ApiKeyRecord,
  type PurchaseEventPayload
} from "@apex-value/schema-gateway-core";
import { Hono } from "hono";
import { decodeEventLog } from "viem";
import { z } from "zod";

import { openApiDocument } from "./openapi.js";

type Bindings = {
  ACCESS_TTL_SECONDS?: string;
  API_KEYS?: KVNamespace;
  CONTRACT_ADDRESS?: string;
  ISSUER_SECRET: string;
  REDEMPTIONS?: KVNamespace;
  RPC_URL?: string;
};

type Variables = {
  keyId: string;
  keyRecord: ApiKeyRecord;
};

const memoryKeys = new Map<string, ApiKeyRecord>();
const memoryRedemptions = new Set<string>();

const NormalizeBodySchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  payload: z.unknown(),
  provider: z.enum(["generic", "openai", "langchain", "ollama"]).optional()
});

const RedeemBodySchema = z.object({
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  label: z.string().min(3).max(64),
  chainId: z.number().int().positive().optional()
});

function getTtlSeconds(env: Bindings): number {
  const parsed = Number.parseInt(env.ACCESS_TTL_SECONDS ?? "86400", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 86400;
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

async function hasRedemption(env: Bindings, txHash: `0x${string}`): Promise<boolean> {
  if (env.REDEMPTIONS) {
    return (await env.REDEMPTIONS.get(`redeemed:${txHash}`)) !== null;
  }

  return memoryRedemptions.has(txHash);
}

async function markRedemption(env: Bindings, txHash: `0x${string}`): Promise<void> {
  if (env.REDEMPTIONS) {
    await env.REDEMPTIONS.put(`redeemed:${txHash}`, "1", {
      expirationTtl: getTtlSeconds(env)
    });
    return;
  }

  memoryRedemptions.add(txHash);
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
  return context.json(
    {
      error: error.message
    },
    500
  );
});

app.get("/health", (context) => {
  return context.json({
    ok: true,
    storage: context.env.API_KEYS ? "kv" : "memory"
  });
});

app.get("/openapi.json", (context) => {
  return context.json(openApiDocument);
});

app.post("/v1/access/redeem", async (context) => {
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

app.use("/v1/normalize", async (context, next) => {
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

  const [prefix, keyId] = providedKey.split(".");
  if (prefix !== "sk_live" || !keyId) {
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
});

app.post("/v1/normalize", async (context) => {
  const body = NormalizeBodySchema.parse(await context.req.json());
  const keyId = context.get("keyId");
  const record = context.get("keyRecord");
  const result = await normalizeStructuredOutput({
    schema: body.schema,
    payload: body.payload,
    ...(body.provider ? { provider: body.provider } : {})
  });

  const updatedRecord: ApiKeyRecord = {
    ...record,
    credits: record.credits - 1,
    lastUsedAt: new Date().toISOString()
  };
  await writeKeyRecord(context.env, updatedRecord);

  const signature = await createSignedEnvelope(context.env.ISSUER_SECRET, {
    keyId,
    schemaHash: result.schemaHash,
    normalized: result.normalized,
    remainingCredits: updatedRecord.credits
  });

  return context.json({
    ...result,
    remainingCredits: updatedRecord.credits,
    signature
  });
});

export type { Bindings };
export { app };
export default app;
