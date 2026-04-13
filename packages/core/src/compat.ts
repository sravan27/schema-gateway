import { sha256Hex } from "./crypto.js";
import type {
  CompileSchemaRequest,
  CompiledSchemaProvider,
  DiffSchemaRequest,
  LintSchemaRequest,
  LintSeverity,
  SchemaChangeRisk,
  SchemaCompilationBundle,
  SchemaCompileVariant,
  SchemaLintIssue,
  SchemaPortabilityReport,
  SchemaPortabilityTarget,
  SchemaProviderReport,
  SchemaRegressionProviderReport,
  SchemaRegressionReport
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

function slugifySchemaName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : "schema_gateway_output";
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

function severityRank(severity: LintSeverity): number {
  switch (severity) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

function lintProvider(
  provider: SchemaPortabilityTarget,
  schema: Record<string, unknown>
): SchemaProviderReport {
  switch (provider) {
    case "openai":
      return lintOpenAi(schema);
    case "gemini":
      return lintGemini(schema);
    case "anthropic":
      return lintAnthropic(schema);
    case "ollama":
      return lintOllama(schema);
  }
}

function issueIdentity(issue: SchemaLintIssue): string {
  return `${issue.provider}:${issue.code}:${issue.path ?? "$"}`;
}

function dedupeIssueList(issues: SchemaLintIssue[]): SchemaLintIssue[] {
  const seen = new Set<string>();
  const deduped: SchemaLintIssue[] = [];

  for (const issue of issues) {
    const key = issueIdentity(issue);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(issue);
  }

  return deduped;
}

function dedupeChangeRisks(risks: SchemaChangeRisk[]): SchemaChangeRisk[] {
  const seen = new Set<string>();
  const deduped: SchemaChangeRisk[] = [];

  for (const risk of risks) {
    const key = `${risk.code}:${risk.path ?? "$"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(risk);
  }

  return deduped;
}

function stableStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice()
    .sort();
}

function typeSignature(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is string => typeof entry === "string").slice().sort();
    return entries.length > 0 ? entries.join("|") : null;
  }

  return null;
}

function enumSignature(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => JSON.stringify(entry)).sort();
}

function addChangeRisk(
  risks: SchemaChangeRisk[],
  severity: LintSeverity,
  code: string,
  message: string,
  path = "$"
): void {
  risks.push({
    code,
    severity,
    message,
    path
  });
}

function compareSchemaShapes(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
  risks: SchemaChangeRisk[],
  path = "$"
): void {
  const baselineType = typeSignature(baseline.type);
  const candidateType = typeSignature(candidate.type);

  if (baselineType && candidateType && baselineType !== candidateType) {
    addChangeRisk(
      risks,
      "warning",
      "schema_type_changed",
      `Type changed from \`${baselineType}\` to \`${candidateType}\`. Existing prompts or consumers may no longer match the same shape.`,
      path
    );
  }

  const baselineEnum = enumSignature(baseline.enum);
  const candidateEnum = enumSignature(candidate.enum);
  if (baselineEnum.length > 0 || candidateEnum.length > 0) {
    const removedValues = baselineEnum.filter((entry) => !candidateEnum.includes(entry));
    const addedValues = candidateEnum.filter((entry) => !baselineEnum.includes(entry));

    if (removedValues.length > 0) {
      addChangeRisk(
        risks,
        "error",
        "schema_enum_values_removed",
        `Enum values were removed: ${removedValues.join(", ")}.`,
        `${path}.enum`
      );
    }

    if (addedValues.length > 0) {
      addChangeRisk(
        risks,
        "info",
        "schema_enum_values_added",
        `Enum values were added: ${addedValues.join(", ")}.`,
        `${path}.enum`
      );
    }
  }

  const baselineProperties = isRecord(baseline.properties) ? baseline.properties : undefined;
  const candidateProperties = isRecord(candidate.properties) ? candidate.properties : undefined;
  const baselineRequired = stableStringArray(baseline.required);
  const candidateRequired = stableStringArray(candidate.required);

  for (const propertyName of candidateRequired) {
    if (!baselineRequired.includes(propertyName)) {
      addChangeRisk(
        risks,
        "error",
        "schema_required_field_added",
        `Property \`${propertyName}\` became required in the candidate schema.`,
        path
      );
    }
  }

  if (baselineProperties && candidateProperties) {
    for (const propertyName of Object.keys(baselineProperties)) {
      if (!(propertyName in candidateProperties)) {
        addChangeRisk(
          risks,
          "error",
          "schema_property_removed",
          `Property \`${propertyName}\` was removed from the candidate schema.`,
          `${path}.properties.${propertyName}`
        );
      }
    }

    for (const propertyName of Object.keys(candidateProperties)) {
      if (!(propertyName in baselineProperties)) {
        addChangeRisk(
          risks,
          candidateRequired.includes(propertyName) ? "warning" : "info",
          "schema_property_added",
          `Property \`${propertyName}\` was added to the candidate schema.`,
          `${path}.properties.${propertyName}`
        );
      }
    }

    for (const [propertyName, baselineProperty] of Object.entries(baselineProperties)) {
      const candidateProperty = candidateProperties[propertyName];
      if (isRecord(baselineProperty) && isRecord(candidateProperty)) {
        compareSchemaShapes(
          baselineProperty,
          candidateProperty,
          risks,
          `${path}.properties.${propertyName}`
        );
      }
    }
  }

  if (isRecord(baseline.items) && isRecord(candidate.items)) {
    compareSchemaShapes(baseline.items, candidate.items, risks, `${path}.items`);
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const baselineEntries = Array.isArray(baseline[keyword]) ? baseline[keyword] : [];
    const candidateEntries = Array.isArray(candidate[keyword]) ? candidate[keyword] : [];
    const sharedLength = Math.min(baselineEntries.length, candidateEntries.length);

    if (baselineEntries.length !== candidateEntries.length) {
      addChangeRisk(
        risks,
        "warning",
        "schema_union_shape_changed",
        `Branch count for \`${keyword}\` changed from ${baselineEntries.length} to ${candidateEntries.length}.`,
        `${path}.${keyword}`
      );
    }

    for (let index = 0; index < sharedLength; index += 1) {
      const baselineEntry = baselineEntries[index];
      const candidateEntry = candidateEntries[index];
      if (isRecord(baselineEntry) && isRecord(candidateEntry)) {
        compareSchemaShapes(
          baselineEntry,
          candidateEntry,
          risks,
          `${path}.${keyword}[${index}]`
        );
      }
    }
  }
}

function compareProviderReports(
  baselineReport: SchemaProviderReport,
  candidateReport: SchemaProviderReport
): SchemaRegressionProviderReport {
  const baselineIndex = new Map(
    baselineReport.issues.map((issue) => [issueIdentity(issue), issue] as const)
  );
  const candidateIndex = new Map(
    candidateReport.issues.map((issue) => [issueIdentity(issue), issue] as const)
  );

  const introducedIssues: SchemaLintIssue[] = [];
  const resolvedIssues: SchemaLintIssue[] = [];
  const persistedIssues: SchemaLintIssue[] = [];

  for (const [key, candidateIssue] of candidateIndex) {
    const baselineIssue = baselineIndex.get(key);
    if (!baselineIssue) {
      introducedIssues.push(candidateIssue);
      continue;
    }

    if (severityRank(candidateIssue.severity) > severityRank(baselineIssue.severity)) {
      introducedIssues.push(candidateIssue);
      continue;
    }

    persistedIssues.push(candidateIssue);
  }

  for (const [key, baselineIssue] of baselineIndex) {
    const candidateIssue = candidateIndex.get(key);
    if (!candidateIssue) {
      resolvedIssues.push(baselineIssue);
      continue;
    }

    if (severityRank(candidateIssue.severity) < severityRank(baselineIssue.severity)) {
      resolvedIssues.push(baselineIssue);
    }
  }

  return {
    provider: candidateReport.provider,
    baselineCompatible: baselineReport.compatible,
    candidateCompatible: candidateReport.compatible,
    baselineScore: baselineReport.score,
    candidateScore: candidateReport.score,
    scoreDelta: candidateReport.score - baselineReport.score,
    introducedIssues: dedupeIssueList(introducedIssues),
    resolvedIssues: dedupeIssueList(resolvedIssues),
    persistedIssues: dedupeIssueList(persistedIssues)
  };
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
  const reports = uniqueProviders.map((provider) => lintProvider(provider, request.schema));

  return {
    schemaHash: await sha256Hex(request.schema),
    providers: reports
  };
}

export async function diffStructuredOutputSchemas(
  request: DiffSchemaRequest
): Promise<SchemaRegressionReport> {
  const providers = request.targets?.length
    ? request.targets
    : (["openai", "gemini", "anthropic", "ollama"] as SchemaPortabilityTarget[]);
  const uniqueProviders = [...new Set(providers)];

  const baselineReports = uniqueProviders.map((provider) =>
    lintProvider(provider, request.baselineSchema)
  );
  const candidateReports = uniqueProviders.map((provider) =>
    lintProvider(provider, request.candidateSchema)
  );

  const providersReport = uniqueProviders.map((provider, index) =>
    compareProviderReports(
      baselineReports[index] as SchemaProviderReport,
      candidateReports[index] as SchemaProviderReport
    )
  );

  const changeRisks: SchemaChangeRisk[] = [];
  compareSchemaShapes(request.baselineSchema, request.candidateSchema, changeRisks);

  const introducedErrorCount = providersReport.reduce(
    (sum, provider) =>
      sum + provider.introducedIssues.filter((issue) => issue.severity === "error").length,
    0
  ) + changeRisks.filter((risk) => risk.severity === "error").length;

  const introducedWarningCount = providersReport.reduce(
    (sum, provider) =>
      sum + provider.introducedIssues.filter((issue) => issue.severity === "warning").length,
    0
  ) + changeRisks.filter((risk) => risk.severity === "warning").length;

  const resolvedIssueCount = providersReport.reduce(
    (sum, provider) => sum + provider.resolvedIssues.length,
    0
  );

  const affectedProviders = providersReport
    .filter(
      (provider) =>
        provider.introducedIssues.length > 0 ||
        provider.scoreDelta < 0 ||
        provider.baselineCompatible !== provider.candidateCompatible
    )
    .map((provider) => provider.provider);

  const hasGlobalRisk = changeRisks.some(
    (risk) => risk.severity === "error" || risk.severity === "warning"
  );
  const effectiveAffectedProviders = hasGlobalRisk
    ? [...new Set([...affectedProviders, ...uniqueProviders])]
    : affectedProviders;

  return {
    baselineHash: await sha256Hex(request.baselineSchema),
    candidateHash: await sha256Hex(request.candidateSchema),
    providers: providersReport,
    changeRisks: dedupeChangeRisks(changeRisks),
    summary: {
      breakingChangeLikely:
        introducedErrorCount > 0 ||
        providersReport.some(
          (provider) => provider.baselineCompatible && !provider.candidateCompatible
        ),
      introducedErrorCount,
      introducedWarningCount,
      resolvedIssueCount,
      affectedProviders: effectiveAffectedProviders
    }
  };
}

function buildCompileVariants(
  providerReport: SchemaProviderReport,
  context: {
    name: string;
    description: string;
    prompt: string;
  }
): { variants: SchemaCompileVariant[]; notes: string[] } {
  const { normalizedSchema, provider } = providerReport;

  switch (provider) {
    case "openai":
      return {
        variants: [
          {
            key: "responses_api",
            label: "OpenAI Responses API",
            requestBody: {
              input: context.prompt,
              text: {
                format: {
                  type: "json_schema",
                  strict: true,
                  schema: normalizedSchema
                }
              }
            }
          },
          {
            key: "chat_completions",
            label: "OpenAI Chat Completions API",
            requestBody: {
              messages: [
                {
                  role: "user",
                  content: context.prompt
                }
              ],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: context.name,
                  strict: true,
                  schema: normalizedSchema
                }
              }
            }
          }
        ],
        notes: [
          "Use the normalized schema fragment below instead of the raw schema when targeting OpenAI strict mode.",
          "If your team still uses Chat Completions, the second variant preserves the `name` wrapper expected by the legacy response format shape."
        ]
      };
    case "gemini":
      return {
        variants: [
          {
            key: "generate_content",
            label: "Gemini generateContent",
            requestBody: {
              contents: [
                {
                  parts: [
                    {
                      text: context.prompt
                    }
                  ]
                }
              ],
              generationConfig: {
                responseMimeType: "application/json",
                responseJsonSchema: normalizedSchema
              }
            }
          }
        ],
        notes: [
          "Gemini expects JSON schema under `responseJsonSchema` with `responseMimeType: application/json`.",
          "Schema Gateway preserves Gemini-friendly property ordering so structured outputs stay stable across model upgrades."
        ]
      };
    case "anthropic":
      return {
        variants: [
          {
            key: "messages_tools",
            label: "Anthropic Messages API tool definition",
            requestBody: {
              messages: [
                {
                  role: "user",
                  content: context.prompt
                }
              ],
              tools: [
                {
                  name: context.name,
                  description: context.description,
                  input_schema: normalizedSchema
                }
              ],
              tool_choice: {
                type: "tool",
                name: context.name
              }
            }
          }
        ],
        notes: [
          "Prefer Anthropic's native tool definitions when you need schema control.",
          "Schema Gateway still warns if you rely on Anthropic's OpenAI compatibility layer because `strict` is ignored there."
        ]
      };
    case "ollama":
      return {
        variants: [
          {
            key: "chat",
            label: "Ollama chat",
            requestBody: {
              messages: [
                {
                  role: "user",
                  content: context.prompt
                }
              ],
              format: normalizedSchema,
              stream: false,
              options: {
                temperature: 0
              }
            }
          }
        ],
        notes: [
          "Ollama structured outputs are most reliable when the prompt explicitly asks for JSON matching the schema.",
          "Use a low temperature such as 0 for deterministic local extraction."
        ]
      };
  }
}

export async function compileStructuredOutputSchema(
  request: CompileSchemaRequest
): Promise<SchemaCompilationBundle> {
  const report = await lintStructuredOutputSchema(request);
  const name = slugifySchemaName(request.name ?? "schema_gateway_output");
  const description =
    request.description?.trim() || "Structured output generated by Schema Gateway.";
  const prompt =
    request.prompt?.trim() ||
    "Return only JSON that matches the provided schema with no extra commentary.";

  const providers = report.providers.map<CompiledSchemaProvider>((providerReport) => {
    const { variants, notes } = buildCompileVariants(providerReport, {
      name,
      description,
      prompt
    });

    return {
      provider: providerReport.provider,
      compatible: providerReport.compatible,
      score: providerReport.score,
      normalizedSchema: providerReport.normalizedSchema,
      issues: providerReport.issues,
      variants,
      notes
    };
  });

  return {
    schemaHash: report.schemaHash,
    name,
    description,
    prompt,
    providers
  };
}
