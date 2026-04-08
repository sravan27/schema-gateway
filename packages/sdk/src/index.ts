import {
  buildLabelCommitment,
  normalizeStructuredOutput,
  type NormalizeRequest,
  type NormalizationResult,
  withRetry
} from "@apex-value/schema-gateway-core";

export interface SchemaGatewayClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface RedeemRequest {
  txHash: `0x${string}`;
  label: string;
  chainId?: number;
}

export interface RedeemResponse {
  apiKey: string;
  keyId: string;
  credits: number;
  signature: `0x${string}`;
  label: string;
}

export class SchemaGatewayClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SchemaGatewayClientOptions = {}) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:8787";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  normalizeLocal(request: NormalizeRequest): Promise<NormalizationResult> {
    return normalizeStructuredOutput(request);
  }

  async normalizeRemote(request: NormalizeRequest): Promise<NormalizationResult & {
    remainingCredits: number;
    signature: `0x${string}`;
  }> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error("An API key is required for remote normalization.");
    }

    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/normalize`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Schema Gateway returned ${response.status} for /v1/normalize.`);
      }

      return (await response.json()) as NormalizationResult & {
        remainingCredits: number;
        signature: `0x${string}`;
      };
    });
  }

  async redeemCredits(request: RedeemRequest): Promise<RedeemResponse> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/access/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Schema Gateway returned ${response.status} for /v1/access/redeem.`);
      }

      return (await response.json()) as RedeemResponse;
    });
  }
}

export async function buildPurchaseMetadata(label: string): Promise<{
  label: string;
  keyCommitment: `0x${string}`;
}> {
  return {
    label,
    keyCommitment: await buildLabelCommitment(label)
  };
}

export * from "@apex-value/schema-gateway-core";
