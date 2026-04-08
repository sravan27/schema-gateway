import { encodeAbiParameters, encodeEventTopics } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildLabelCommitment, purchaseEventAbiItem } from "@apex-value/schema-gateway-core";

import { app, type Bindings } from "../src/index.js";

describe("worker", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("redeems a purchase receipt and spends a credit on normalization", async () => {
    const env: Bindings = {
      ACCESS_TTL_SECONDS: "3600",
      ALLOW_EPHEMERAL_STORAGE: "true",
      CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000abc",
      ISSUER_SECRET: "test-secret",
      RPC_URL: "https://rpc.example"
    };

    const txHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    const label = "backend-router";
    const commitment = await buildLabelCommitment(label);
    const topics = encodeEventTopics({
      abi: [purchaseEventAbiItem],
      eventName: "Purchase",
      args: {
        buyer: "0x0000000000000000000000000000000000000def",
        token: "0x0000000000000000000000000000000000000000",
        keyCommitment: commitment
      }
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" }
      ],
      [15n, 3n]
    );

    globalThis.fetch = vi.fn(async (input) => {
      if (input !== env.RPC_URL) {
        throw new Error(`Unexpected fetch target: ${String(input)}`);
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            logs: [
              {
                address: env.CONTRACT_ADDRESS,
                topics,
                data
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const redeemResponse = await app.request(
      "http://example.test/v1/access/redeem",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          txHash,
          label
        })
      },
      env
    );

    expect(redeemResponse.status).toBe(201);
    const redeemed = (await redeemResponse.json()) as {
      apiKey: string;
      credits: number;
    };
    expect(redeemed.apiKey).toMatch(/^sk_live\./);
    expect(redeemed.credits).toBe(3);

    const normalizeResponse = await app.request(
      "http://example.test/v1/normalize",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": redeemed.apiKey
        },
        body: JSON.stringify({
          schema: {
            type: "object",
            properties: {
              age: { type: "integer" },
              active: { type: "boolean" }
            },
            required: ["age", "active"],
            additionalProperties: false
          },
          payload: "```json\n{\"age\":\"42\",\"active\":\"true\"}\n```"
        })
      },
      env
    );

    expect(normalizeResponse.status).toBe(200);
    const normalized = (await normalizeResponse.json()) as {
      valid: boolean;
      normalized: { age: number; active: boolean };
      remainingCredits: number;
    };

    expect(normalized.valid).toBe(true);
    expect(normalized.normalized).toEqual({
      age: 42,
      active: true
    });
    expect(normalized.remainingCredits).toBe(2);
  });

  it("fails loudly when a paid route is deployed without persistent storage", async () => {
    const env: Bindings = {
      ISSUER_SECRET: "test-secret"
    };

    const response = await app.request(
      "http://example.test/v1/access/polar/claim",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          orderId: "polar-order-1",
          email: "buyer@example.com"
        })
      },
      env
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Persistent storage is required");
    expect(body.error).toContain("POLAR_CLAIMS");
  });

  it("serves a product landing page at the root path", async () => {
    const env: Bindings = {
      CHECKOUT_URL: "https://buy.polar.sh/test-checkout",
      ISSUER_SECRET: "test-secret",
      PUBLIC_CONTACT_EMAIL: "founder@example.com"
    };

    const response = await app.request("http://example.test/", {}, env);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Schema Gateway Pro");
    expect(html).toContain("/openapi.json");
    expect(html).toContain("https://buy.polar.sh/test-checkout");
    expect(html).toContain("founder@example.com");
  });

  it("returns a signed schema portability report and spends one credit", async () => {
    const env: Bindings = {
      ACCESS_TTL_SECONDS: "3600",
      ALLOW_EPHEMERAL_STORAGE: "true",
      CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000abc",
      ISSUER_SECRET: "test-secret",
      RPC_URL: "https://rpc.example"
    };

    const txHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    const label = "linting-service";
    const commitment = await buildLabelCommitment(label);
    const topics = encodeEventTopics({
      abi: [purchaseEventAbiItem],
      eventName: "Purchase",
      args: {
        buyer: "0x0000000000000000000000000000000000000def",
        token: "0x0000000000000000000000000000000000000000",
        keyCommitment: commitment
      }
    });
    const data = encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" }
      ],
      [15n, 3n]
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            logs: [
              {
                address: env.CONTRACT_ADDRESS,
                topics,
                data
              }
            ]
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const redeemResponse = await app.request(
      "http://example.test/v1/access/redeem",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          txHash,
          label
        })
      },
      env
    );
    const redeemed = (await redeemResponse.json()) as {
      apiKey: string;
    };

    const lintResponse = await app.request(
      "http://example.test/v1/lint",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": redeemed.apiKey
        },
        body: JSON.stringify({
          schema: {
            type: "object",
            properties: {
              city: { type: "string" },
              units: { type: "string" }
            },
            required: ["city"]
          },
          targets: ["openai", "gemini"]
        })
      },
      env
    );

    expect(lintResponse.status).toBe(200);
    const linted = (await lintResponse.json()) as {
      schemaHash: string;
      providers: Array<{
        provider: string;
        normalizedSchema: Record<string, unknown>;
      }>;
      remainingCredits: number;
      signature: string;
    };

    expect(linted.schemaHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(linted.signature).toMatch(/^0x[a-f0-9]{64}$/);
    expect(linted.remainingCredits).toBe(2);
    expect(linted.providers.map((provider) => provider.provider)).toEqual(["openai", "gemini"]);
    expect(linted.providers[0]?.normalizedSchema).toMatchObject({
      additionalProperties: false,
      required: ["city", "units"]
    });
    expect(linted.providers[1]?.normalizedSchema).toMatchObject({
      propertyOrdering: ["city", "units"]
    });
  });

  it("claims stateless Polar access and uses it without KV storage", async () => {
    const env: Bindings = {
      ISSUER_SECRET: "test-secret",
      POLAR_ACCESS_TOKEN: "polar-token",
      POLAR_ACCESS_TTL_SECONDS: "3600",
      POLAR_PRODUCT_ID: "product_123"
    };

    globalThis.fetch = vi.fn(async (input) => {
      if (String(input) !== "https://api.polar.sh/v1/orders/order_123") {
        throw new Error(`Unexpected fetch target: ${String(input)}`);
      }

      return new Response(
        JSON.stringify({
          id: "order_123",
          status: "paid",
          product_id: "product_123",
          customer: {
            email: "buyer@example.com",
            name: "Buyer"
          },
          product: {
            id: "product_123",
            name: "Schema Gateway Pro"
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }) as typeof fetch;

    const claimResponse = await app.request(
      "http://example.test/v1/access/polar/claim",
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          orderId: "order_123",
          email: "buyer@example.com"
        })
      },
      env
    );

    expect(claimResponse.status).toBe(200);
    const claimed = (await claimResponse.json()) as {
      apiKey: string;
      accessMode: string;
      expiresAt: string;
    };
    expect(claimed.apiKey).toMatch(/^sk_live\.access\./);
    expect(claimed.accessMode).toBe("stateless");
    expect(claimed.expiresAt).toContain("T");

    const lintResponse = await app.request(
      "http://example.test/v1/lint",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": claimed.apiKey
        },
        body: JSON.stringify({
          schema: {
            type: "object",
            properties: {
              city: { type: "string" }
            },
            required: []
          },
          targets: ["openai"]
        })
      },
      env
    );

    expect(lintResponse.status).toBe(200);
    const linted = (await lintResponse.json()) as {
      accessMode: string;
      expiresAt: string;
      remainingCredits: null;
    };
    expect(linted.accessMode).toBe("stateless");
    expect(linted.expiresAt).toContain("T");
    expect(linted.remainingCredits).toBeNull();
  });
});
