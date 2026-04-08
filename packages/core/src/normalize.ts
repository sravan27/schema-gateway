import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { jsonrepair } from "jsonrepair";

import { sha256Hex } from "./crypto.js";
import type {
  NormalizeRequest,
  NormalizationIssue,
  NormalizationResult,
  NormalizedToolCall,
  SourceKind
} from "./types.js";
import { extractJsonCandidate, isRecord } from "./utils.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});
addFormats(ajv);

interface Candidate {
  value: unknown;
  sourceKind: SourceKind;
  repaired: boolean;
  extractedJson: boolean;
  issues: NormalizationIssue[];
}

function collectTextCandidates(payload: unknown): string[] {
  if (typeof payload === "string") {
    return [payload];
  }

  if (!isRecord(payload)) {
    return [];
  }

  const texts: string[] = [];

  if (typeof payload.output_text === "string") {
    texts.push(payload.output_text);
  }

  if (typeof payload.content === "string") {
    texts.push(payload.content);
  }

  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (isRecord(item) && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
  }

  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!isRecord(item)) {
        continue;
      }

      if (typeof item.text === "string") {
        texts.push(item.text);
      }

      if (Array.isArray(item.content)) {
        for (const contentItem of item.content) {
          if (isRecord(contentItem) && typeof contentItem.text === "string") {
            texts.push(contentItem.text);
          }
        }
      }
    }
  }

  if (isRecord(payload.message) && Array.isArray(payload.message.content)) {
    for (const item of payload.message.content) {
      if (isRecord(item) && typeof item.text === "string") {
        texts.push(item.text);
      }
    }
  }

  return texts;
}

function toToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }

  return { value };
}

function sanitizeJsonCandidate(raw: string): {
  value: string;
  changed: boolean;
} {
  const sanitized = raw
    .replace(/,\s*,+/g, ",")
    .replace(/,\s*([}\]])/g, "$1");

  return {
    value: sanitized,
    changed: sanitized !== raw
  };
}

function tryParseJsonString(raw: string): {
  ok: boolean;
  parsed?: unknown;
  repaired: boolean;
  extractedJson: boolean;
  sourceKind: SourceKind;
  issues: NormalizationIssue[];
} {
  const trimmed = raw.trim();
  const issues: NormalizationIssue[] = [];

  try {
    return {
      ok: true,
      parsed: JSON.parse(trimmed),
      repaired: false,
      extractedJson: false,
      sourceKind: "json_string",
      issues
    };
  } catch {
    // Continue through repair strategies.
  }

  const extracted = extractJsonCandidate(trimmed);
  if (extracted.candidate) {
    const sanitizedExtracted = sanitizeJsonCandidate(extracted.candidate);

    try {
      return {
        ok: true,
        parsed: JSON.parse(sanitizedExtracted.value),
        repaired: sanitizedExtracted.changed,
        extractedJson: true,
        sourceKind: extracted.sourceKind,
        issues: [
          ...issues,
          ...extracted.issues,
          ...(sanitizedExtracted.changed
            ? [
                {
                  code: "json_sanitized",
                  message: "Applied lightweight sanitation before parsing malformed JSON."
                } satisfies NormalizationIssue
              ]
            : [])
        ]
      };
    } catch {
      try {
        const repaired = jsonrepair(sanitizedExtracted.value);
        return {
          ok: true,
          parsed: JSON.parse(repaired),
          repaired: true,
          extractedJson: true,
          sourceKind: extracted.sourceKind,
          issues: [
            ...issues,
            ...extracted.issues,
            ...(sanitizedExtracted.changed
              ? [
                  {
                    code: "json_sanitized",
                    message: "Applied lightweight sanitation before parsing malformed JSON."
                  } satisfies NormalizationIssue
                ]
              : []),
            {
              code: "json_repaired",
              message: "Repaired malformed JSON before validation."
            }
          ]
        };
      } catch {
        // Fall through to the raw repair path.
      }
    }
  }

  const sanitizedRaw = sanitizeJsonCandidate(trimmed);
  try {
    const repaired = jsonrepair(sanitizedRaw.value);
    return {
      ok: true,
      parsed: JSON.parse(repaired),
      repaired: true,
      extractedJson: false,
      sourceKind: "json_string",
      issues: [
        ...(sanitizedRaw.changed
          ? [
              {
                code: "json_sanitized",
                message: "Applied lightweight sanitation before parsing malformed JSON."
              } satisfies NormalizationIssue
            ]
          : []),
        {
          code: "json_repaired",
          message: "Repaired malformed JSON before validation."
        }
      ]
    };
  } catch {
    return {
      ok: false,
      repaired: false,
      extractedJson: false,
      sourceKind: "unknown",
      issues: [
        {
          code: "json_parse_failed",
          message: "Unable to parse the payload as JSON."
        }
      ]
    };
  }
}

export function normalizeToolCalls(payload: unknown): NormalizedToolCall[] {
  const toolCalls: NormalizedToolCall[] = [];

  const pushToolCall = (name: unknown, argumentsValue: unknown, source: string, raw: unknown) => {
    if (typeof name !== "string" || name.length === 0) {
      return;
    }

    let parsedArguments = argumentsValue;
    if (typeof argumentsValue === "string") {
      const parsed = tryParseJsonString(argumentsValue);
      parsedArguments = parsed.ok ? parsed.parsed : { raw: argumentsValue };
    }

    toolCalls.push({
      name,
      arguments: toToolArguments(parsedArguments),
      raw,
      source
    });
  };

  if (!isRecord(payload)) {
    return toolCalls;
  }

  if (Array.isArray(payload.tool_calls)) {
    for (const entry of payload.tool_calls) {
      if (!isRecord(entry)) {
        continue;
      }

      if (isRecord(entry.function)) {
        pushToolCall(entry.function.name, entry.function.arguments, "tool_calls", entry);
      } else {
        pushToolCall(entry.name, entry.arguments, "tool_calls", entry);
      }
    }
  }

  if (isRecord(payload.message) && Array.isArray(payload.message.tool_calls)) {
    for (const entry of payload.message.tool_calls) {
      if (isRecord(entry.function)) {
        pushToolCall(entry.function.name, entry.function.arguments, "message.tool_calls", entry);
      }
    }
  }

  if (isRecord(payload.additional_kwargs) && Array.isArray(payload.additional_kwargs.tool_calls)) {
    for (const entry of payload.additional_kwargs.tool_calls) {
      if (isRecord(entry.function)) {
        pushToolCall(
          entry.function.name,
          entry.function.arguments,
          "additional_kwargs.tool_calls",
          entry
        );
      }
    }
  }

  if (Array.isArray(payload.output)) {
    for (const entry of payload.output) {
      if (!isRecord(entry) || entry.type !== "function_call") {
        continue;
      }
      pushToolCall(entry.name, entry.arguments, "output.function_call", entry);
    }
  }

  return toolCalls;
}

function buildCandidates(payload: unknown, toolCalls: NormalizedToolCall[]): Candidate[] {
  const candidates: Candidate[] = [
    {
      value: payload,
      sourceKind: typeof payload === "string" ? "json_string" : "direct",
      repaired: false,
      extractedJson: false,
      issues: []
    }
  ];

  for (const text of collectTextCandidates(payload)) {
    candidates.push({
      value: text,
      sourceKind: "provider_envelope",
      repaired: false,
      extractedJson: false,
      issues: [
        {
          code: "provider_envelope",
          message: "Pulled a text candidate from a provider-specific envelope."
        }
      ]
    });
  }

  for (const toolCall of toolCalls) {
    candidates.push({
      value: toolCall.arguments,
      sourceKind: "tool_call_arguments",
      repaired: false,
      extractedJson: false,
      issues: [
        {
          code: "tool_call_candidate",
          message: `Used tool call arguments from ${toolCall.name} as a schema candidate.`
        }
      ]
    });
  }

  return candidates;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): NormalizationIssue[] {
  if (!errors) {
    return [];
  }

  return errors.map((error) => ({
    code: "schema_validation_failed",
    message: error.message ?? "Schema validation failed.",
    path: error.instancePath || error.schemaPath
  }));
}

function coerceValue(
  schema: Record<string, unknown>,
  value: unknown,
  issues: NormalizationIssue[],
  path = "$"
): unknown {
  const variants = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;

  if (variants) {
    let bestCandidate = value;
    let bestIssueCount = Number.POSITIVE_INFINITY;

    for (const variant of variants) {
      if (!isRecord(variant)) {
        continue;
      }

      const probeIssues: NormalizationIssue[] = [];
      const candidate = coerceValue(variant, value, probeIssues, path);
      if (probeIssues.length < bestIssueCount) {
        bestCandidate = candidate;
        bestIssueCount = probeIssues.length;
      }
      if (probeIssues.length === 0) {
        return candidate;
      }
    }

    return bestCandidate;
  }

  const schemaType = schema.type;
  const allowedTypes = Array.isArray(schemaType)
    ? schemaType
    : typeof schemaType === "string"
      ? [schemaType]
      : [];

  if (allowedTypes.includes("integer") || allowedTypes.includes("number")) {
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
      issues.push({
        code: "coerced_number",
        message: `Coerced a string into a numeric value at ${path}.`,
        path
      });
      return allowedTypes.includes("integer") ? Number.parseInt(value, 10) : Number(value);
    }
  }

  if (allowedTypes.includes("boolean")) {
    if (value === "true" || value === "false") {
      issues.push({
        code: "coerced_boolean",
        message: `Coerced a string into a boolean at ${path}.`,
        path
      });
      return value === "true";
    }
  }

  if (allowedTypes.includes("string") && typeof value !== "string" && value !== undefined && value !== null) {
    issues.push({
      code: "coerced_string",
      message: `Coerced a non-string value into a string at ${path}.`,
      path
    });
    return String(value);
  }

  if (allowedTypes.includes("array") && isRecord(schema) && value !== undefined) {
    const items = isRecord(schema.items) ? schema.items : null;
    if (!Array.isArray(value)) {
      issues.push({
        code: "wrapped_array",
        message: `Wrapped a single value into an array at ${path}.`,
        path
      });
      return items ? [coerceValue(items, value, issues, `${path}[0]`)] : [value];
    }

    return items
      ? value.map((entry, index) => coerceValue(items, entry, issues, `${path}[${index}]`))
      : value;
  }

  if (allowedTypes.includes("object") && isRecord(value)) {
    const properties = isRecord(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : undefined;

    if (!properties) {
      return value;
    }

    const output: Record<string, unknown> = { ...value };

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isRecord(propertySchema) || !(key in output)) {
        continue;
      }

      output[key] = coerceValue(propertySchema, output[key], issues, `${path}.${key}`);
    }

    return output;
  }

  return value;
}

export async function normalizeStructuredOutput(
  request: NormalizeRequest
): Promise<NormalizationResult> {
  const schemaHash = await sha256Hex(request.schema);
  const toolCalls = normalizeToolCalls(request.payload);
  const candidates = buildCandidates(request.payload, toolCalls);

  let validator;
  try {
    validator = ajv.compile(request.schema);
  } catch (error) {
    return {
      valid: false,
      normalized: null,
      repaired: false,
      extractedJson: false,
      toolCalls,
      schemaHash,
      sourceKind: "unknown",
      issues: [
        {
          code: "invalid_schema",
          message: error instanceof Error ? error.message : "The supplied schema could not be compiled."
        }
      ]
    };
  }

  let bestFailure: NormalizationResult | null = null;

  for (const candidate of candidates) {
    let value = candidate.value;
    let repaired = candidate.repaired;
    let extractedJson = candidate.extractedJson;
    let sourceKind = candidate.sourceKind;
    const issues: NormalizationIssue[] = [...candidate.issues];

    if (typeof value === "string") {
      const parsed = tryParseJsonString(value);
      issues.push(...parsed.issues);
      if (!parsed.ok) {
        const failedResult: NormalizationResult = {
          valid: false,
          normalized: null,
          repaired,
          extractedJson,
          toolCalls,
          issues,
          schemaHash,
          sourceKind
        };
        if (!bestFailure || failedResult.issues.length < bestFailure.issues.length) {
          bestFailure = failedResult;
        }
        continue;
      }

      value = parsed.parsed;
      repaired ||= parsed.repaired;
      extractedJson ||= parsed.extractedJson;
      sourceKind = parsed.sourceKind;
    }

    const coercedIssues: NormalizationIssue[] = [];
    const coercedValue = coerceValue(request.schema, value, coercedIssues);
    issues.push(...coercedIssues);

    const valid = validator(coercedValue);
    if (valid) {
      return {
        valid: true,
        normalized: coercedValue,
        repaired,
        extractedJson,
        toolCalls,
        issues,
        schemaHash,
        sourceKind
      };
    }

    issues.push(...formatAjvErrors(validator.errors));
    const failedResult: NormalizationResult = {
      valid: false,
      normalized: coercedValue,
      repaired,
      extractedJson,
      toolCalls,
      issues,
      schemaHash,
      sourceKind
    };

    if (!bestFailure || failedResult.issues.length < bestFailure.issues.length) {
      bestFailure = failedResult;
    }
  }

  return (
    bestFailure ?? {
      valid: false,
      normalized: null,
      repaired: false,
      extractedJson: false,
      toolCalls,
      issues: [
        {
          code: "no_candidate",
          message: "No viable JSON candidate could be extracted from the payload."
        }
      ],
      schemaHash,
      sourceKind: "unknown"
    }
  );
}
