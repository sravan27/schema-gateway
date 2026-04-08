import { sha256Hex } from "./crypto.js";
import type {
  LintSchemaRequest,
  LintSeverity,
  SchemaLintIssue,
  SchemaPortabilityReport,
  SchemaPortabilityTarget,
  SchemaProviderReport
} from "./types.js";
import { isRecord } from "./utils.js";

const OPENAI_UNSUPPORTED_KEYWORDS = new Set([
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "patternProperties"
]);

const GEMINI_SOFT_UNSUPPORTED_KEYWORDS = new Set([
  "default",
  "examples",
  "pattern",
  "patternProperties",
  "contentEncoding",
  "contentMediaType",
  "unevaluatedItems",
  "unevaluatedProperties"
]);

function cloneSchema<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addIssue(
  issues: SchemaLintIssue[],
  provider: SchemaPortabilityTarget,
  severity: LintSeverity,
  code: string,
  message: string,
  path = "$",
  fixApplied = false
): void {
  issues.push({
    provider,
    severity,
    code,
    message,
    path,
    ...(fixApplied ? { fixApplied } : {})
  });
}

function computeScore(issues: SchemaLintIssue[]): number {
  let score = 100;

  for (const issue of issues) {
    if (issue.severity === "error") {
      score -= 25;
      continue;
    }

    if (issue.severity === "warning") {
      score -= 10;
      continue;
    }

    score -= 2;
  }

  return Math.max(0, score);
}

function schemaAllowsNull(schema: Record<string, unknown>): boolean {
  if (schema.type === "null") {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  if ("const" in schema && schema.const === null) {
    return true;
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((entry) => isRecord(entry) && schemaAllowsNull(entry));
  }

  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.some((entry) => isRecord(entry) && schemaAllowsNull(entry));
  }

  return false;
}

function makeSchemaNullable(schema: Record<string, unknown>): boolean {
  if (schemaAllowsNull(schema)) {
    return false;
  }

  if (typeof schema.type === "string") {
    schema.type = [schema.type, "null"];
    return true;
  }

  if (Array.isArray(schema.type)) {
    schema.type = [...schema.type, "null"];
    return true;
  }

  if (Array.isArray(schema.enum)) {
    schema.enum = [...schema.enum, null];
    return true;
  }

  if ("const" in schema) {
    schema.enum = [schema.const, null];
    delete schema.const;
    return true;
  }

  if (Array.isArray(schema.anyOf)) {
    schema.anyOf = [...schema.anyOf, { type: "null" }];
    return true;
  }

  if (Array.isArray(schema.oneOf)) {
    schema.oneOf = [...schema.oneOf, { type: "null" }];
    return true;
  }

  const snapshot = cloneSchema(schema);
  for (const key of Object.keys(schema)) {
    delete schema[key];
  }
  schema.anyOf = [snapshot, { type: "null" }];
  return true;
}

function forEachChildSchema(
  schema: Record<string, unknown>,
  visit: (child: Record<string, unknown>, path: string) => void,
  path: string
): void {
  if (isRecord(schema.properties)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      if (isRecord(propertySchema)) {
        visit(propertySchema, `${path}.properties.${propertyName}`);
      }
    }
  }

  if (isRecord(schema.items)) {
    visit(schema.items, `${path}.items`);
  }

  if (Array.isArray(schema.prefixItems)) {
    schema.prefixItems.forEach((entry, index) => {
      if (isRecord(entry)) {
        visit(entry, `${path}.prefixItems[${index}]`);
      }
    });
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const entries = schema[keyword];
    if (!Array.isArray(entries)) {
      continue;
    }

    entries.forEach((entry, index) => {
      if (isRecord(entry)) {
        visit(entry, `${path}.${keyword}[${index}]`);
      }
    });
  }

  for (const keyword of ["not", "if", "then", "else"] as const) {
    const child = schema[keyword];
    if (isRecord(child)) {
      visit(child, `${path}.${keyword}`);
    }
  }

  for (const keyword of ["$defs", "definitions"] as const) {
    const childMap = schema[keyword];
    if (!isRecord(childMap)) {
      continue;
    }

    for (const [key, child] of Object.entries(childMap)) {
      if (isRecord(child)) {
        visit(child, `${path}.${keyword}.${key}`);
      }
    }
  }
}

function lintOpenAi(schema: Record<string, unknown>): SchemaProviderReport {
  const normalizedSchema = cloneSchema(schema);
  const issues: SchemaLintIssue[] = [];
  let maxDepth = 0;
  let totalProperties = 0;
  let totalEnumValues = 0;
  let totalStringBudget = 0;

  const visit = (node: Record<string, unknown>, path: string, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);

    for (const keyword of OPENAI_UNSUPPORTED_KEYWORDS) {
      if (keyword in node) {
        addIssue(
          issues,
          "openai",
          "error",
          "openai_unsupported_keyword",
          `OpenAI strict structured outputs do not support \`${keyword}\` at ${path}.`,
          `${path}.${keyword}`
        );
      }
    }

    if (Array.isArray(node.enum)) {
      totalEnumValues += node.enum.length;
      totalStringBudget += node.enum.reduce(
        (sum, value) => sum + (typeof value === "string" ? value.length : 0),
        0
      );
    }

    if ("const" in node && typeof node.const === "string") {
      totalStringBudget += node.const.length;
    }

    const hasObjectShape =
      node.type === "object" ||
      (Array.isArray(node.type) && node.type.includes("object")) ||
      isRecord(node.properties);

    if (hasObjectShape) {
      if (node.additionalProperties !== false) {
        node.additionalProperties = false;
        addIssue(
          issues,
          "openai",
          "error",
          "openai_additional_properties_required",
          "OpenAI strict mode requires `additionalProperties: false` on every object schema.",
          path,
          true
        );
      }

      if (isRecord(node.properties)) {
        const propertyEntries = Object.entries(node.properties).filter(([, entry]) => isRecord(entry));
        const propertyNames = propertyEntries.map(([propertyName]) => propertyName);
        totalProperties += propertyNames.length;

        const existingRequired = Array.isArray(node.required)
          ? node.required.filter((value): value is string => typeof value === "string")
          : [];
        const missingRequired = propertyNames.filter(
          (propertyName) => !existingRequired.includes(propertyName)
        );

        if (missingRequired.length > 0) {
          node.required = propertyNames;
          addIssue(
            issues,
            "openai",
            "error",
            "openai_all_fields_must_be_required",
            `OpenAI strict mode requires all object properties to appear in \`required\`. Promoted ${missingRequired.join(", ")} to required.`,
            path,
            true
          );

          for (const propertyName of missingRequired) {
            const propertySchema = node.properties[propertyName];
            if (!isRecord(propertySchema)) {
              continue;
            }

            if (makeSchemaNullable(propertySchema)) {
              addIssue(
                issues,
                "openai",
                "info",
                "openai_optional_property_made_nullable",
                `Converted optional property \`${propertyName}\` into a nullable required field to preserve optional semantics in OpenAI strict mode.`,
                `${path}.properties.${propertyName}`,
                true
              );
            }
          }
        }
      }
    }

    forEachChildSchema(node, (child, childPath) => visit(child, childPath, depth + 1), path);
  };

  visit(normalizedSchema, "$", 1);

  if (maxDepth > 10) {
    addIssue(
      issues,
      "openai",
      "error",
      "openai_schema_too_deep",
      "OpenAI strict mode limits schemas to 10 nesting levels.",
      "$"
    );
  }

  if (totalProperties > 5000) {
    addIssue(
      issues,
      "openai",
      "error",
      "openai_too_many_properties",
      "OpenAI strict mode limits a schema to 5,000 object properties across the full schema.",
      "$"
    );
  }

  if (totalEnumValues > 1000) {
    addIssue(
      issues,
      "openai",
      "error",
      "openai_too_many_enum_values",
      "OpenAI strict mode limits a schema to 1,000 enum values across the full schema.",
      "$"
    );
  }

  if (totalStringBudget > 120000) {
    addIssue(
      issues,
      "openai",
      "error",
      "openai_schema_string_budget_exceeded",
      "OpenAI strict mode limits the total string budget for property names and enum values.",
      "$"
    );
  }

  return {
    provider: "openai",
    compatible: !issues.some((issue) => issue.severity === "error"),
    score: computeScore(issues),
    normalizedSchema,
    issues
  };
}

function lintGemini(schema: Record<string, unknown>): SchemaProviderReport {
  const normalizedSchema = cloneSchema(schema);
  const issues: SchemaLintIssue[] = [];

  const visit = (node: Record<string, unknown>, path: string): void => {
    for (const keyword of GEMINI_SOFT_UNSUPPORTED_KEYWORDS) {
      if (keyword in node) {
        addIssue(
          issues,
          "gemini",
          "warning",
          "gemini_keyword_may_be_ignored",
          `Gemini's structured output schema support is a subset of OpenAPI/JSON Schema, so \`${keyword}\` may be ignored.`,
          `${path}.${keyword}`
        );
      }
    }

    if (isRecord(node.properties)) {
      const propertyOrdering = Object.keys(node.properties);
      const existingOrdering = Array.isArray(node.propertyOrdering)
        ? node.propertyOrdering.filter((value): value is string => typeof value === "string")
        : [];

      if (
        existingOrdering.length !== propertyOrdering.length ||
        existingOrdering.some((value, index) => value !== propertyOrdering[index])
      ) {
        node.propertyOrdering = propertyOrdering;
        addIssue(
          issues,
          "gemini",
          "info",
          "gemini_property_ordering_added",
          "Added `propertyOrdering` to preserve field order for Gemini structured outputs.",
          path,
          true
        );
      }
    }

    forEachChildSchema(node, visit, path);
  };

  visit(normalizedSchema, "$");

  return {
    provider: "gemini",
    compatible: !issues.some((issue) => issue.severity === "error"),
    score: computeScore(issues),
    normalizedSchema,
    issues
  };
}

function lintAnthropic(schema: Record<string, unknown>): SchemaProviderReport {
  const issues: SchemaLintIssue[] = [];
  addIssue(
    issues,
    "anthropic",
    "warning",
    "anthropic_openai_compat_strict_ignored",
    "Anthropic's OpenAI SDK compatibility layer ignores the `strict` parameter for function calling. Use native Claude structured outputs when you need guaranteed schema conformance.",
    "$"
  );

  return {
    provider: "anthropic",
    compatible: true,
    score: computeScore(issues),
    normalizedSchema: cloneSchema(schema),
    issues
  };
}

function lintOllama(schema: Record<string, unknown>): SchemaProviderReport {
  const issues: SchemaLintIssue[] = [];
  addIssue(
    issues,
    "ollama",
    "info",
    "ollama_ground_with_schema",
    "Ollama structured outputs are more reliable when you also include the JSON schema in the prompt.",
    "$"
  );
  addIssue(
    issues,
    "ollama",
    "info",
    "ollama_temperature_hint",
    "Ollama recommends low temperature values such as 0 for deterministic structured outputs.",
    "$"
  );

  return {
    provider: "ollama",
    compatible: true,
    score: computeScore(issues),
    normalizedSchema: cloneSchema(schema),
    issues
  };
}

export async function lintStructuredOutputSchema(
  request: LintSchemaRequest
): Promise<SchemaPortabilityReport> {
  const providers = request.targets?.length
    ? request.targets
    : (["openai", "gemini", "anthropic", "ollama"] as SchemaPortabilityTarget[]);

  const uniqueProviders = [...new Set(providers)];
  const reports = uniqueProviders.map((provider) => {
    switch (provider) {
      case "openai":
        return lintOpenAi(request.schema);
      case "gemini":
        return lintGemini(request.schema);
      case "anthropic":
        return lintAnthropic(request.schema);
      case "ollama":
        return lintOllama(request.schema);
    }
  });

  return {
    schemaHash: await sha256Hex(request.schema),
    providers: reports
  };
}
