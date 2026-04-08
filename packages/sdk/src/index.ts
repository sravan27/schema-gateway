import {
  buildLabelCommitment,
  lintStructuredOutputSchema,
  type LintSchemaRequest,
  type SchemaPortabilityReport,
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

export interface PolarClaimRequest {
  orderId: string;
  email: string;
}

export interface PolarClaimResponse {
  apiKey: string;
  orderId: string;
  email: string;
  issuedAt?: string;
  expiresAt?: string;
  productId?: string;
  productName?: string;
  accessMode?: string;
  keyId?: string;
  credits?: number;
}

export interface RemoteLintResponse extends SchemaPortabilityReport {
  remainingCredits: number | null;
  signature: `0x${string}`;
  accessMode?: string;
  expiresAt?: string;
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

  lintLocal(request: LintSchemaRequest): Promise<SchemaPortabilityReport> {
    return lintStructuredOutputSchema(request);
  }

  async normalizeRemote(request: NormalizeRequest): Promise<NormalizationResult & {
    remainingCredits: number | null;
    signature: `0x${string}`;
    accessMode?: string;
    expiresAt?: string;
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
        remainingCredits: number | null;
        signature: `0x${string}`;
        accessMode?: string;
        expiresAt?: string;
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

  async claimPolarAccess(request: PolarClaimRequest): Promise<PolarClaimResponse> {
    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/access/polar/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(
          `Schema Gateway returned ${response.status} for /v1/access/polar/claim.`
        );
      }

      return (await response.json()) as PolarClaimResponse;
    });
  }

  async lintRemote(request: LintSchemaRequest): Promise<RemoteLintResponse> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error("An API key is required for remote schema linting.");
    }

    return withRetry(async () => {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/lint`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Schema Gateway returned ${response.status} for /v1/lint.`);
      }

      return (await response.json()) as RemoteLintResponse;
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
