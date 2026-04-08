export type SupportedProvider = "generic" | "openai" | "langchain" | "ollama";
export type SchemaPortabilityTarget = "openai" | "gemini" | "anthropic" | "ollama";
export type LintSeverity = "error" | "warning" | "info";

export type SourceKind =
  | "direct"
  | "json_string"
  | "fenced_json"
  | "provider_envelope"
  | "tool_call_arguments"
  | "unknown";

export interface NormalizeRequest {
  schema: Record<string, unknown>;
  payload: unknown;
  provider?: SupportedProvider;
}

export interface LintSchemaRequest {
  schema: Record<string, unknown>;
  targets?: SchemaPortabilityTarget[];
}

export interface NormalizedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: unknown;
  source: string;
}

export interface NormalizationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface SchemaLintIssue {
  code: string;
  message: string;
  path?: string;
  severity: LintSeverity;
  provider: SchemaPortabilityTarget;
  fixApplied?: boolean;
}

export interface SchemaProviderReport {
  provider: SchemaPortabilityTarget;
  compatible: boolean;
  score: number;
  normalizedSchema: Record<string, unknown>;
  issues: SchemaLintIssue[];
}

export interface SchemaPortabilityReport {
  schemaHash: `0x${string}`;
  providers: SchemaProviderReport[];
}

export interface NormalizationResult {
  valid: boolean;
  normalized: unknown;
  repaired: boolean;
  extractedJson: boolean;
  toolCalls: NormalizedToolCall[];
  issues: NormalizationIssue[];
  schemaHash: `0x${string}`;
  sourceKind: SourceKind;
}

export interface ApiKeyRecord {
  keyId: string;
  label: string;
  hashedKey: `0x${string}`;
  credits: number;
  issuedAt: string;
  lastUsedAt?: string;
  txHash: `0x${string}`;
  signature: `0x${string}`;
}

export interface PurchaseEventPayload {
  buyer: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  credits: bigint;
  keyCommitment: `0x${string}`;
  txHash: `0x${string}`;
}
