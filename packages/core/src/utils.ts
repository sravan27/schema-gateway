import type { NormalizationIssue, SourceKind } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(",")}}`;
}

function findBalancedJsonSlice(text: string): string | null {
  let start = -1;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (quote) {
      if (!escaped && char === quote) {
        quote = null;
      }
      escaped = !escaped && char === "\\";
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

export function extractJsonCandidate(text: string): {
  candidate: string | null;
  sourceKind: SourceKind;
  issues: NormalizationIssue[];
} {
  const issues: NormalizationIssue[] = [];
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch?.[1]) {
    return {
      candidate: fencedMatch[1].trim(),
      sourceKind: "fenced_json",
      issues
    };
  }

  const balanced = findBalancedJsonSlice(text);
  if (balanced) {
    issues.push({
      code: "json_extracted",
      message: "Extracted the first balanced JSON payload from surrounding text."
    });
    return {
      candidate: balanced.trim(),
      sourceKind: "json_string",
      issues
    };
  }

  return {
    candidate: null,
    sourceKind: "unknown",
    issues
  };
}
