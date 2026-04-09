import {
  buildLabelCommitment,
  compileStructuredOutputSchema,
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

const CompileBodySchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  targets: z.array(z.enum(["openai", "gemini", "anthropic", "ollama"])).optional(),
  name: z.string().min(1).max(64).optional(),
  description: z.string().min(1).max(280).optional(),
  prompt: z.string().min(1).max(4000).optional()
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

type ComparePage = {
  slug: string;
  shortTitle: string;
  title: string;
  description: string;
  headline: string;
  intro: string;
  searchTerms: string[];
  constraints: string[];
  fixes: string[];
  docs: Array<{ label: string; url: string }>;
  snippet: string;
};

const PUBLIC_REPO_URL = "https://github.com/sravan27/schema-gateway";
const PUBLIC_INDEXNOW_KEY = "0d712c316dcc009314c1cddfefaad8a2";
const PUBLIC_RELEASE_VERSION = "0.1.3";
const PUBLIC_RELEASE_TAG = `v${PUBLIC_RELEASE_VERSION}`;
const PUBLIC_CORE_INSTALL_URL = `${PUBLIC_REPO_URL}/releases/download/${PUBLIC_RELEASE_TAG}/apex-value-schema-gateway-core-${PUBLIC_RELEASE_VERSION}.tgz`;
const PUBLIC_SDK_INSTALL_URL = `${PUBLIC_REPO_URL}/releases/download/${PUBLIC_RELEASE_TAG}/apex-value-schema-gateway-${PUBLIC_RELEASE_VERSION}.tgz`;
const PUBLIC_INSTALL_COMMAND = `npm install ${PUBLIC_CORE_INSTALL_URL} ${PUBLIC_SDK_INSTALL_URL}`;
const PUBLIC_ACTION_REF = PUBLIC_RELEASE_TAG;
const DEMO_DEFAULT_TARGETS: SchemaPortabilityTarget[] = ["openai", "gemini"];
const DEMO_MAX_BODY_BYTES = 12_000;
const DEMO_MAX_SCHEMA_BYTES = 6_000;
const DEMO_SAMPLE_SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string" },
    temperatureC: { type: "number" },
    condition: { type: "string" },
    advisories: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: ["city", "temperatureC", "condition", "advisories"],
  additionalProperties: false
} satisfies Record<string, unknown>;
const PUBLIC_CI_SNIPPET = `name: Schema portability

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check-schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: sravan27/schema-gateway/.github/actions/portability-check@${PUBLIC_ACTION_REF}
        with:
          schema: schema.json
          targets: openai,gemini,anthropic,ollama`;
const PUBLIC_COMPILE_SNIPPET = `schema-gateway compile \\
  --schema ./schema.json \\
  --target openai,gemini,anthropic,ollama \\
  --name extraction_result`;
const ROOT_FAQ = [
  {
    question: "What problem does Schema Gateway solve?",
    answer:
      "It fixes structured-output portability problems across OpenAI, Gemini, Anthropic compatibility mode, Ollama, and framework wrappers such as LangChain. One schema goes in; provider-specific drift, repair, and portability diagnostics come out."
  },
  {
    question: "Why would a team pay for this instead of validating locally?",
    answer:
      "The free SDK covers local validation and repair. The paid service adds signed remote enforcement, provider-portability linting, shared production access, and a claimable access path for teams that need a stable API origin."
  },
  {
    question: "Is this a financial or regulated product?",
    answer:
      "No. It is prepaid API software for schema normalization and portability checks. It does not do KYC, custody, money transmission, lending, investing, outreach, or spam."
  }
] as const;

const COMPARE_PAGES: ComparePage[] = [
  {
    slug: "openai-structured-outputs",
    shortTitle: "OpenAI",
    title: "OpenAI Structured Outputs Schema Limits and Fixes",
    description:
      "Learn why OpenAI strict structured outputs break on optional properties, missing required fields, and permissive objects, and how Schema Gateway rewrites schemas for production use.",
    headline: "OpenAI Structured Outputs break when your schema is merely 'valid JSON Schema'.",
    intro:
      "OpenAI strict mode is powerful, but it is not a generic JSON Schema runtime. Teams regularly discover this after wiring a schema that validates locally and then fails in production.",
    searchTerms: [
      "openai structured outputs additionalProperties false",
      "openai all fields must be required",
      "openai strict json schema optional fields"
    ],
    constraints: [
      "Strict mode expects object schemas to pin down their shape instead of leaving extra keys open.",
      "Optional-looking properties often need to become required nullable fields to preserve semantics cleanly.",
      "Large or deeply nested schemas become fragile fast."
    ],
    fixes: [
      "Rewrite permissive objects to `additionalProperties: false`.",
      "Promote missing properties into `required` and make formerly optional fields nullable.",
      "Score compatibility before shipping so CI catches breakage earlier than runtime."
    ],
    docs: [
      {
        label: "OpenAI Structured Outputs",
        url: "https://developers.openai.com/api/docs/guides/structured-outputs"
      }
    ],
    snippet: `schema-gateway lint --schema ./schema.json --target openai`
  },
  {
    slug: "gemini-structured-output",
    shortTitle: "Gemini",
    title: "Gemini Structured Output Schema Subset and propertyOrdering",
    description:
      "Gemini structured outputs support only a subset of JSON Schema and Gemini 2.0 needs explicit propertyOrdering. Schema Gateway surfaces the gaps and rewrites the schema variant.",
    headline: "Gemini structured output is not a full JSON Schema engine either.",
    intro:
      "Google's Gemini docs explicitly describe a subset model. That means schema portability fails in subtle ways when teams assume one provider-safe JSON Schema will behave identically everywhere.",
    searchTerms: [
      "gemini structured output propertyOrdering",
      "gemini subset json schema structured output",
      "gemini response_json_schema propertyOrdering"
    ],
    constraints: [
      "Gemini structured output supports only a subset of JSON Schema.",
      "Gemini 2.0 requires an explicit `propertyOrdering` list for preferred structure.",
      "Unsupported schema properties can be ignored, which makes failures hard to notice."
    ],
    fixes: [
      "Add `propertyOrdering` automatically where it matters.",
      "Warn on schema keywords likely to be ignored.",
      "Generate a provider-specific variant instead of forcing one schema to fit every runtime."
    ],
    docs: [
      {
        label: "Gemini Structured Outputs",
        url: "https://ai.google.dev/gemini-api/docs/structured-output"
      }
    ],
    snippet: `schema-gateway lint --schema ./schema.json --target gemini`
  },
  {
    slug: "anthropic-openai-compat",
    shortTitle: "Anthropic",
    title: "Anthropic OpenAI Compatibility and strict Schema Drift",
    description:
      "Anthropic's OpenAI compatibility layer is useful for testing, but their docs say the strict function-calling parameter is ignored. Schema Gateway catches the mismatch before teams assume conformance.",
    headline: "Anthropic's OpenAI compatibility mode is for comparison, not blind production parity.",
    intro:
      "The compatibility layer is real and useful, but Anthropic documents important differences. If a team expects OpenAI-style strict guarantees through that layer, they can ship false confidence into production.",
    searchTerms: [
      "anthropic openai sdk compatibility strict ignored",
      "claude openai compatibility structured outputs",
      "anthropic strict function calling ignored"
    ],
    constraints: [
      "Anthropic states that the OpenAI compatibility layer is primarily for testing and comparison.",
      "The `strict` parameter for function calling is ignored in that layer.",
      "Some unsupported request fields are silently ignored rather than hard-failing."
    ],
    fixes: [
      "Flag compatibility-mode risk before deploys.",
      "Separate 'schema-valid' from 'provider-guaranteed'.",
      "Push teams toward native Claude structured outputs when they need hard conformance."
    ],
    docs: [
      {
        label: "Anthropic OpenAI SDK compatibility",
        url: "https://platform.claude.com/docs/en/api/openai-sdk"
      }
    ],
    snippet: `schema-gateway lint --schema ./schema.json --target anthropic`
  },
  {
    slug: "ollama-structured-outputs",
    shortTitle: "Ollama",
    title: "Ollama Structured Outputs and Local Model Reliability",
    description:
      "Ollama supports structured outputs with JSON schema, but local pipelines still benefit from repair, validation, and provider-portable schema checks. Schema Gateway adds that reliability layer.",
    headline: "Ollama gives you local structured outputs. You still need guardrails.",
    intro:
      "Ollama's structured output support is a strong local building block, but teams still need validation, portability checks, and consistent behavior when the same schema also targets hosted providers.",
    searchTerms: [
      "ollama structured outputs json schema",
      "ollama schema validation structured outputs",
      "ollama structured output reliability"
    ],
    constraints: [
      "Local models still drift, especially when prompts and schema complexity grow.",
      "A schema that works in Ollama may still need edits for hosted providers.",
      "Teams often need one linting layer across local and hosted inference."
    ],
    fixes: [
      "Normalize malformed tool payloads before they hit your application code.",
      "Use the same schema portability report across Ollama and hosted APIs.",
      "Keep local validation free while buying shared enforcement only when needed."
    ],
    docs: [
      {
        label: "Ollama structured outputs",
        url: "https://ollama.com/blog/structured-outputs"
      }
    ],
    snippet: `schema-gateway validate --schema ./schema.json --payload ./payload.json --provider ollama`
  }
];

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

function renderSiteNav(baseUrl: string): string {
  return `<nav class="site-nav">
    <a class="brand" href="${escapeHtml(baseUrl)}/">Schema Gateway</a>
    <div class="nav-links">
      <a href="${escapeHtml(baseUrl)}/compare">Comparisons</a>
      <a href="${escapeHtml(baseUrl)}/compiler">Compiler</a>
      <a href="${escapeHtml(baseUrl)}/ci">CI</a>
      <a href="${escapeHtml(baseUrl)}/install">Install</a>
      <a href="${escapeHtml(baseUrl)}/pricing">Pricing</a>
      <a href="${escapeHtml(baseUrl)}/openapi.json">OpenAPI</a>
      <a href="${escapeHtml(PUBLIC_REPO_URL)}">GitHub</a>
    </div>
  </nav>`;
}

function renderSiteFooter(baseUrl: string): string {
  return `<footer class="site-footer">
    <div>Schema Gateway ships provider-portable schema validation for OpenAI, Gemini, Anthropic, Ollama, and framework wrappers.</div>
    <div class="footer-links">
      <a href="${escapeHtml(baseUrl)}/">Home</a>
      <a href="${escapeHtml(baseUrl)}/compare">Comparisons</a>
      <a href="${escapeHtml(baseUrl)}/compiler">Compiler</a>
      <a href="${escapeHtml(baseUrl)}/ci">CI</a>
      <a href="${escapeHtml(baseUrl)}/install">Install</a>
      <a href="${escapeHtml(baseUrl)}/pricing">Pricing</a>
      <a href="${escapeHtml(baseUrl)}/llms.txt">llms.txt</a>
      <a href="${escapeHtml(PUBLIC_REPO_URL)}">GitHub</a>
    </div>
  </footer>`;
}

function renderCodeBlock(code: string): string {
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

function renderCompilerDemoScript(baseUrl: string): string {
  return `<script>
(() => {
  const form = document.getElementById("demo-compile-form");
  const schemaField = document.getElementById("demo-schema");
  const targetsField = document.getElementById("demo-targets");
  const status = document.getElementById("demo-status");
  const summary = document.getElementById("demo-summary");
  const rawOutput = document.getElementById("demo-raw-output");
  const useSampleButton = document.getElementById("demo-use-sample");
  const runButton = document.getElementById("demo-run");
  const targetToggles = Array.from(document.querySelectorAll("[data-demo-target]"));
  const endpoint = ${JSON.stringify(`${baseUrl}/v1/demo/compile`)};
  const sampleSchema = ${JSON.stringify(JSON.stringify(DEMO_SAMPLE_SCHEMA, null, 2))};

  if (!(form instanceof HTMLFormElement) || !(schemaField instanceof HTMLTextAreaElement) || !(targetsField instanceof HTMLInputElement) || !(status instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(rawOutput instanceof HTMLElement)) {
    return;
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function makeNode(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (typeof text === "string") {
      node.textContent = text;
    }
    return node;
  }

  function stringifyPreview(value) {
    const raw = JSON.stringify(value, null, 2);
    if (raw.length <= 900) {
      return raw;
    }
    return raw.slice(0, 900) + "\\n...";
  }

  function summarizeIssues(issues) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return "No schema issues in this target.";
    }

    const counts = { error: 0, warning: 0, info: 0 };
    for (const issue of issues) {
      if (issue && typeof issue.severity === "string" && issue.severity in counts) {
        counts[issue.severity] += 1;
      }
    }

    return [
      counts.error > 0 ? counts.error + " error" + (counts.error === 1 ? "" : "s") : null,
      counts.warning > 0 ? counts.warning + " warning" + (counts.warning === 1 ? "" : "s") : null,
      counts.info > 0 ? counts.info + " info note" + (counts.info === 1 ? "" : "s") : null
    ].filter(Boolean).join(" • ");
  }

  function setStatus(message, variant) {
    status.textContent = message;
    status.dataset.variant = variant;
  }

  function syncTargetToggles() {
    const activeTargets = new Set(
      targetsField.value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );

    for (const toggle of targetToggles) {
      const target = toggle.getAttribute("data-demo-target");
      const active = !!target && activeTargets.has(target);
      toggle.setAttribute("aria-pressed", active ? "true" : "false");
      toggle.classList.toggle("is-active", active);
    }
  }

  function renderError(message, rawValue) {
    clearNode(summary);
    const card = makeNode("div", "demo-empty-state");
    card.append(makeNode("div", "demo-empty-kicker", "Demo request failed"));
    card.append(makeNode("div", "demo-empty-title", message));
    card.append(makeNode("p", "demo-empty-copy", "Fix the schema or targets, then run the demo again."));
    summary.append(card);
    rawOutput.textContent = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue, null, 2);
  }

  function renderPayload(payload) {
    clearNode(summary);
    rawOutput.textContent = JSON.stringify(payload, null, 2);

    const providerCount = Array.isArray(payload.providers) ? payload.providers.length : 0;
    const compatibleCount = Array.isArray(payload.providers)
      ? payload.providers.filter((provider) => provider.compatible).length
      : 0;

    const header = makeNode("div", "demo-summary-head");
    const heading = makeNode("div", "stack");
    heading.append(makeNode("div", "demo-summary-kicker", "Hosted compiler result"));
    heading.append(
      makeNode(
        "div",
        "demo-summary-title",
        providerCount > 0
          ? payload.name + " • " + compatibleCount + "/" + providerCount + " targets ready"
          : payload.name
      )
    );
    const badge = makeNode("div", "demo-badge", payload.demo ? "Free demo" : "Signed API");
    header.append(heading, badge);
    summary.append(header);

    if (Array.isArray(payload.providers)) {
      const tabs = makeNode("div", "demo-provider-tabs");
      const inspector = makeNode("div", "demo-inspector");
      let activeProviderIndex = 0;
      let activeVariantIndex = 0;

      function renderInspector() {
        clearNode(tabs);
        clearNode(inspector);

        payload.providers.forEach((provider, index) => {
          const button = makeNode(
            "button",
            index === activeProviderIndex ? "demo-tab is-active" : "demo-tab"
          );
          button.type = "button";
          button.append(
            makeNode("span", "demo-tab-title", provider.provider),
            makeNode("span", "demo-tab-subtitle", "Score " + String(provider.score))
          );
          button.addEventListener("click", () => {
            activeProviderIndex = index;
            activeVariantIndex = 0;
            renderInspector();
          });
          tabs.append(button);
        });

        const provider = payload.providers[activeProviderIndex];
        if (!provider) {
          return;
        }

        const top = makeNode("div", "demo-inspector-top");
        const left = makeNode("div", "stack");
        left.append(
          makeNode("div", "demo-provider-heading", provider.provider),
          makeNode(
            "p",
            "demo-provider-copy",
            Array.isArray(provider.notes) && typeof provider.notes[0] === "string"
              ? provider.notes[0]
              : "Provider-ready fragment generated from the normalized schema."
          )
        );
        const state = makeNode(
          "div",
          provider.compatible ? "demo-provider-badge is-good" : "demo-provider-badge is-fix",
          provider.compatible ? "Ready to ship" : "Needs fixes"
        );
        top.append(left, state);

        const stats = makeNode("div", "demo-provider-stats");
        stats.append(
          makeNode("span", "demo-provider-stat", "Score " + String(provider.score)),
          makeNode(
            "span",
            "demo-provider-stat",
            Array.isArray(provider.variants)
              ? String(provider.variants.length) + " compiled variant" + (provider.variants.length === 1 ? "" : "s")
              : "0 compiled variants"
          ),
          makeNode("span", "demo-provider-stat", summarizeIssues(provider.issues))
        );

        const body = makeNode("div", "demo-inspector-body");
        const meta = makeNode("div", "demo-info-panel");
        meta.append(
          makeNode("div", "demo-provider-variant-label", "What changed"),
          makeNode(
            "p",
            "demo-provider-copy",
            Array.isArray(provider.notes) && provider.notes.length > 1 && typeof provider.notes[1] === "string"
              ? provider.notes[1]
              : "Schema Gateway emits a provider-specific request body from the normalized schema so you do not have to maintain per-runtime glue code."
          )
        );

        const codeShell = makeNode("div", "demo-code-panel");
        const variantTabs = makeNode("div", "demo-variant-tabs");
        const variants = Array.isArray(provider.variants) ? provider.variants : [];
        const safeVariantIndex =
          activeVariantIndex < variants.length ? activeVariantIndex : 0;
        activeVariantIndex = safeVariantIndex;
        variants.forEach((variant, index) => {
          const button = makeNode(
            "button",
            index === activeVariantIndex ? "demo-variant-tab is-active" : "demo-variant-tab",
            variant.label
          );
          button.type = "button";
          button.addEventListener("click", () => {
            activeVariantIndex = index;
            renderInspector();
          });
          variantTabs.append(button);
        });

        const activeVariant = variants[activeVariantIndex] ?? null;
        const variantLabel = makeNode(
          "div",
          "demo-provider-variant-label",
          activeVariant ? activeVariant.key.replace(/_/g, " ") : "compiled request body"
        );
        const codeBlock = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = activeVariant ? stringifyPreview(activeVariant.requestBody) : "{}";
        codeBlock.append(code);
        codeShell.append(variantTabs, variantLabel, codeBlock);

        body.append(meta, codeShell);
        inspector.append(top, stats, body);
      }

      summary.append(tabs, inspector);
      renderInspector();
    }
  }

  async function runDemo() {
    let schema;

    try {
      schema = JSON.parse(schemaField.value);
    } catch (error) {
      setStatus("Schema JSON is invalid. Fix the syntax and try again.", "error");
      renderError("Schema JSON is invalid.", error instanceof Error ? error.message : String(error));
      return;
    }

    const targets = targetsField.value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    runButton?.setAttribute("disabled", "disabled");
    setStatus("Running the free hosted demo...", "loading");
    clearNode(summary);
    rawOutput.textContent = "";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          schema,
          ...(targets.length > 0 ? { targets } : {})
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        setStatus(payload.error ?? "The demo request failed.", "error");
        renderError(payload.error ?? "The demo request failed.", payload);
        return;
      }

      const compatibleProviders = Array.isArray(payload.providers)
        ? payload.providers.filter((provider) => provider.compatible).map((provider) => provider.provider)
        : [];
      setStatus(
        compatibleProviders.length > 0
          ? "Demo ready. Compatible providers: " + compatibleProviders.join(", ")
          : "Demo ran. This schema still needs provider fixes before it is portable.",
        "success"
      );
      renderPayload(payload);
    } catch (error) {
      setStatus("Network error while calling the demo endpoint.", "error");
      renderError("Network error while calling the demo endpoint.", error instanceof Error ? error.message : String(error));
    } finally {
      runButton?.removeAttribute("disabled");
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runDemo();
  });

  useSampleButton?.addEventListener("click", () => {
    schemaField.value = sampleSchema;
    targetsField.value = ${JSON.stringify(DEMO_DEFAULT_TARGETS.join(","))};
    syncTargetToggles();
    setStatus("Sample schema loaded. Run the free demo to see provider-ready output.", "idle");
  });

  targetToggles.forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const target = toggle.getAttribute("data-demo-target");
      if (!target) {
        return;
      }

      const targets = targetsField.value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const targetSet = new Set(targets);

      if (targetSet.has(target) && targetSet.size > 1) {
        targetSet.delete(target);
      } else {
        targetSet.add(target);
      }

      targetsField.value = Array.from(targetSet).join(",");
      syncTargetToggles();
    });
  });

  syncTargetToggles();
  setStatus("Loading a sample compile run...", "loading");
  void runDemo();
})();
</script>`;
}

function renderMarketingPage(context: {
  baseUrl: string;
  path: string;
  title: string;
  description: string;
  body: string;
  jsonLd?: unknown;
}): string {
  const canonicalUrl = `${context.baseUrl}${context.path === "/" ? "" : context.path}`;
  const jsonLdMarkup = context.jsonLd
    ? `<script type="application/ld+json">${serializeJsonLd(context.jsonLd)}</script>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(context.title)}</title>
    <meta name="description" content="${escapeHtml(context.description)}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(context.title)}">
    <meta property="og:description" content="${escapeHtml(context.description)}">
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(context.title)}">
    <meta name="twitter:description" content="${escapeHtml(context.description)}">
    ${jsonLdMarkup}
    <style>
      @import url("https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap");
      :root {
        color-scheme: light;
        --bg: #f2f0ea;
        --panel: rgba(255, 255, 255, 0.7);
        --panel-solid: #fbfaf7;
        --ink: #101519;
        --muted: #5a646d;
        --accent: #16686a;
        --accent-ink: #f6fffd;
        --border: rgba(16, 21, 25, 0.08);
        --shadow: 0 24px 80px rgba(18, 24, 29, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Manrope", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(116, 188, 255, 0.14), transparent 24%),
          radial-gradient(circle at top right, rgba(22, 104, 106, 0.12), transparent 28%),
          linear-gradient(180deg, #faf8f4 0%, var(--bg) 100%);
        color: var(--ink);
      }
      a {
        color: inherit;
      }
      .site-nav,
      .site-footer {
        max-width: 1120px;
        margin: 0 auto;
        padding: 24px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
      }
      .site-footer {
        border-top: 1px solid var(--border);
        color: var(--muted);
        font-size: 0.95rem;
        flex-wrap: wrap;
        padding-bottom: 36px;
      }
      .brand {
        text-decoration: none;
        font-weight: 700;
        letter-spacing: -0.04em;
      }
      .nav-links,
      .footer-links {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
      }
      .nav-links a,
      .footer-links a {
        color: var(--muted);
        text-decoration: none;
      }
      main {
        max-width: 1120px;
        margin: 0 auto;
        padding: 10px 20px 80px;
      }
      .panel {
        background: var(--panel-solid);
        border: 1px solid var(--border);
        border-radius: 28px;
        padding: 28px;
        box-shadow: var(--shadow);
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(280px, 0.9fr);
        gap: 22px;
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
      h2 {
        margin: 0 0 14px;
        font-size: clamp(1.35rem, 3vw, 2rem);
        letter-spacing: -0.03em;
      }
      h3 {
        margin: 0 0 10px;
        font-size: 1.08rem;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 28px 0 6px;
      }
      .primary, .secondary, .ghost {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        border-radius: 14px;
        padding: 0 16px;
        text-decoration: none;
        font-weight: 600;
      }
      .primary {
        background: var(--accent);
        color: var(--accent-ink);
        box-shadow: 0 14px 30px rgba(22, 104, 106, 0.18);
      }
      .secondary {
        border: 1px solid var(--border);
        color: var(--ink);
        background: rgba(255, 255, 255, 0.9);
      }
      .ghost {
        border: 1px dashed var(--border);
        color: var(--muted);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
        gap: 14px;
        margin-top: 28px;
      }
      .card {
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 18px;
        background: rgba(255, 255, 255, 0.7);
      }
      .stack {
        display: grid;
        gap: 18px;
      }
      .section {
        margin-top: 26px;
      }
      .list {
        margin: 0;
        padding-left: 18px;
        display: grid;
        gap: 8px;
      }
      .matrix {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.97rem;
      }
      .matrix th,
      .matrix td {
        border-top: 1px solid var(--border);
        padding: 12px 10px;
        text-align: left;
        vertical-align: top;
      }
      .matrix th {
        color: var(--muted);
        font-weight: 600;
      }
      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 18px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        border: 1px solid rgba(15, 118, 110, 0.18);
        color: #0b5d57;
        font-size: 0.92rem;
      }
      pre {
        margin: 0;
        overflow-x: auto;
        border-radius: 18px;
        padding: 16px;
        background: #132028;
        color: #f4efe5;
        white-space: pre;
      }
      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 0.95em;
      }
      ul {
        margin: 10px 0 0;
        padding-left: 18px;
      }
      .faq-item + .faq-item {
        margin-top: 16px;
      }
      .form-grid {
        display: grid;
        gap: 14px;
      }
      .field {
        display: grid;
        gap: 8px;
      }
      .field-label {
        color: var(--muted);
        font-size: 0.95rem;
      }
      input,
      textarea {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 14px 16px;
        background: rgba(255, 255, 255, 0.92);
        color: var(--ink);
        font: inherit;
      }
      textarea {
        min-height: 260px;
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 0.95rem;
        line-height: 1.55;
        resize: vertical;
      }
      button.primary,
      button.secondary {
        cursor: pointer;
        border: 0;
      }
      button.primary[disabled],
      button.secondary[disabled] {
        opacity: 0.7;
        cursor: progress;
      }
      .result-shell {
        display: grid;
        gap: 12px;
      }
      .compiler-hero-shell {
        display: grid;
        grid-template-columns: minmax(0, 1.02fr) minmax(320px, 0.98fr);
        gap: 16px;
        overflow: hidden;
      }
      .compiler-hero-copy {
        gap: 20px;
        padding: 34px;
        background:
          radial-gradient(circle at top left, rgba(116, 188, 255, 0.16), transparent 36%),
          linear-gradient(150deg, #fffdf9 0%, #f4efe5 100%);
      }
      .compiler-kicker {
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-size: 0.82rem;
      }
      .compiler-lede {
        max-width: 34rem;
        font-size: 1.14rem;
      }
      .compiler-stat-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
      }
      .compiler-stat {
        display: grid;
        gap: 4px;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.74);
        border: 1px solid rgba(15, 118, 110, 0.14);
      }
      .compiler-stat strong {
        font-size: 1.05rem;
      }
      .compiler-stat span {
        color: var(--muted);
        font-size: 0.92rem;
      }
      .compiler-hero-note {
        font-size: 0.96rem;
        color: var(--muted);
      }
      .compiler-preview {
        display: grid;
        gap: 16px;
        padding: 24px;
        background:
          radial-gradient(circle at top right, rgba(72, 196, 170, 0.12), transparent 30%),
          linear-gradient(180deg, #11181d 0%, #10161a 100%);
        color: #ecf6f3;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .compiler-preview .eyebrow,
      .compiler-preview .meta {
        color: rgba(236, 246, 243, 0.72);
      }
      .compiler-chip-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .compiler-chip {
        display: grid;
        gap: 4px;
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .compiler-chip strong {
        font-size: 0.94rem;
      }
      .compiler-chip span {
        color: rgba(236, 246, 243, 0.7);
        font-size: 0.86rem;
      }
      .compiler-window {
        display: grid;
        gap: 0;
        border-radius: 20px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04);
      }
      .compiler-window-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.05);
      }
      .compiler-window-dot {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.3);
      }
      .compiler-window-label {
        margin-left: auto;
        color: rgba(236, 246, 243, 0.66);
        font-size: 0.82rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .compiler-window pre {
        border-radius: 0;
        padding: 18px;
        background: transparent;
      }
      .compiler-grid {
        display: grid;
        gap: 18px;
      }
      .compiler-benefits {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
        margin-top: 18px;
      }
      .compiler-benefit {
        display: grid;
        gap: 10px;
        padding: 18px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.76);
        border: 1px solid var(--border);
      }
      .compiler-benefit p {
        margin: 0;
        font-size: 1rem;
      }
      .compiler-lab {
        display: grid;
        gap: 22px;
        padding: 28px;
        background:
          radial-gradient(circle at top right, rgba(116, 188, 255, 0.14), transparent 24%),
          linear-gradient(180deg, #fffdfa 0%, #f7f1e7 100%);
      }
      .compiler-lab-copy {
        max-width: 44rem;
      }
      .compiler-lab [data-variant="error"] {
        color: #9f2b1c;
      }
      .compiler-lab [data-variant="success"] {
        color: #0b5d57;
      }
      .compiler-lab [data-variant="loading"] {
        color: #7c5f1b;
      }
      .compiler-lab-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 18px;
        flex-wrap: wrap;
      }
      .compiler-limit-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .compiler-limit {
        display: inline-flex;
        align-items: center;
        min-height: 38px;
        padding: 0 14px;
        border-radius: 999px;
        background: rgba(15, 118, 110, 0.08);
        border: 1px solid rgba(15, 118, 110, 0.14);
        font-size: 0.9rem;
        color: #0b5d57;
      }
      .compiler-lab-grid {
        display: grid;
        grid-template-columns: minmax(300px, 0.78fr) minmax(0, 1.22fr);
        gap: 16px;
      }
      .compiler-form-shell,
      .compiler-output-shell {
        display: grid;
        gap: 16px;
        padding: 20px;
        border-radius: 26px;
        border: 1px solid var(--border);
      }
      .compiler-form-shell {
        background:
          radial-gradient(circle at top left, rgba(255, 255, 255, 0.08), transparent 24%),
          linear-gradient(180deg, #12191d 0%, #172026 100%);
        color: #eef4f2;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
      }
      .compiler-form-shell .field-label,
      .compiler-form-shell .meta,
      .compiler-form-shell .eyebrow {
        color: rgba(238, 244, 242, 0.7);
      }
      .compiler-output-shell {
        background: rgba(255, 255, 255, 0.88);
      }
      .compiler-form-shell input,
      .compiler-form-shell textarea {
        border-color: rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04);
        color: #f5faf8;
      }
      .compiler-form-shell textarea {
        min-height: 360px;
        border-radius: 20px;
        padding: 18px;
      }
      .compiler-output-shell pre {
        min-height: 0;
        border: 1px solid rgba(15, 118, 110, 0.08);
        background: #132028;
      }
      .compiler-output-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .compiler-output-caption {
        color: var(--muted);
        font-size: 0.95rem;
      }
      .demo-target-picker {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .demo-target-toggle {
        display: inline-flex;
        align-items: center;
        min-height: 38px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(238, 244, 242, 0.8);
        cursor: pointer;
        font: inherit;
      }
      .demo-target-toggle.is-active {
        background: rgba(22, 104, 106, 0.22);
        border-color: rgba(117, 224, 214, 0.22);
        color: #eafaf6;
      }
      .demo-hidden-input {
        display: none;
      }
      .compiler-form-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .compiler-form-title {
        display: grid;
        gap: 6px;
      }
      .compiler-form-title p {
        margin: 0;
        font-size: 0.98rem;
        color: rgba(238, 244, 242, 0.72);
      }
      .compiler-run-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .compiler-form-shell .primary,
      .compiler-form-shell .secondary {
        min-height: 42px;
        border-radius: 14px;
      }
      .compiler-form-shell .secondary {
        background: rgba(255, 255, 255, 0.92);
        color: var(--ink);
      }
      .compiler-note-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .compiler-note-card {
        display: grid;
        gap: 8px;
        padding: 20px;
        border-radius: 22px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid var(--border);
      }
      .compiler-note-card p {
        margin: 0;
        font-size: 1rem;
      }
      .demo-summary {
        display: grid;
        gap: 16px;
      }
      .demo-summary-head {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .demo-summary-kicker {
        color: var(--muted);
        font-size: 0.86rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .demo-summary-title {
        font-size: 1.1rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .demo-badge {
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        background: rgba(22, 104, 106, 0.08);
        border: 1px solid rgba(22, 104, 106, 0.14);
        color: #11595c;
        font-size: 0.88rem;
        font-weight: 600;
      }
      .demo-provider-tabs {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 10px;
      }
      .demo-tab {
        display: grid;
        gap: 2px;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.72);
        color: inherit;
        text-align: left;
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
      }
      .demo-tab:hover {
        transform: translateY(-1px);
        border-color: rgba(22, 104, 106, 0.22);
      }
      .demo-tab.is-active {
        background: linear-gradient(180deg, rgba(22, 104, 106, 0.12), rgba(255, 255, 255, 0.86));
        border-color: rgba(22, 104, 106, 0.24);
      }
      .demo-tab-title {
        font-size: 0.94rem;
        font-weight: 700;
        text-transform: capitalize;
      }
      .demo-tab-subtitle {
        color: var(--muted);
        font-size: 0.82rem;
      }
      .demo-inspector {
        display: grid;
        gap: 16px;
        padding: 20px;
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(248, 243, 234, 0.92));
        border: 1px solid var(--border);
      }
      .demo-inspector-top {
        display: flex;
        justify-content: space-between;
        gap: 14px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .demo-provider-heading {
        font-size: 1.18rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        text-transform: capitalize;
      }
      .demo-provider-badge {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        font-size: 0.82rem;
        font-weight: 700;
      }
      .demo-provider-badge.is-good {
        background: rgba(15, 118, 110, 0.1);
        color: #0b5d57;
      }
      .demo-provider-badge.is-fix {
        background: rgba(159, 43, 28, 0.1);
        color: #9f2b1c;
      }
      .demo-provider-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .demo-provider-stat {
        display: inline-flex;
        align-items: center;
        min-height: 28px;
        padding: 0 9px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(15, 118, 110, 0.08);
        font-size: 0.82rem;
        color: var(--muted);
      }
      .demo-provider-copy {
        margin: 0;
        font-size: 0.98rem;
        line-height: 1.55;
        color: var(--muted);
      }
      .demo-provider-variant-label {
        color: var(--muted);
        font-size: 0.84rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .demo-inspector-body {
        display: grid;
        grid-template-columns: minmax(200px, 0.72fr) minmax(0, 1.28fr);
        gap: 16px;
      }
      .demo-info-panel,
      .demo-code-panel {
        display: grid;
        gap: 12px;
        padding: 16px;
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.66);
        border: 1px solid rgba(16, 21, 25, 0.06);
      }
      .demo-variant-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .demo-variant-tab {
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.8);
        color: inherit;
        cursor: pointer;
        font: inherit;
      }
      .demo-variant-tab.is-active {
        background: rgba(22, 104, 106, 0.1);
        border-color: rgba(22, 104, 106, 0.22);
        color: #11595c;
      }
      .demo-code-panel pre {
        border-radius: 16px;
        padding: 14px;
        font-size: 0.84rem;
        max-height: 380px;
        overflow: auto;
      }
      .demo-raw-shell {
        border-top: 1px solid var(--border);
        padding-top: 14px;
      }
      .demo-raw-shell summary {
        cursor: pointer;
        color: var(--muted);
        font-size: 0.92rem;
        font-weight: 600;
      }
      .demo-raw-shell pre {
        margin-top: 12px;
      }
      .demo-empty-state {
        display: grid;
        gap: 10px;
        padding: 20px;
        border-radius: 20px;
        background: rgba(159, 43, 28, 0.06);
        border: 1px solid rgba(159, 43, 28, 0.12);
      }
      .demo-empty-kicker {
        color: #9f2b1c;
        font-size: 0.84rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .demo-empty-title {
        font-size: 1.04rem;
        font-weight: 700;
      }
      .demo-empty-copy {
        margin: 0;
        font-size: 0.96rem;
        color: var(--muted);
      }
      [data-variant="error"] {
        color: #9f2b1c;
      }
      [data-variant="success"] {
        color: #0b5d57;
      }
      [data-variant="loading"] {
        color: #7c5f1b;
      }
      @media (max-width: 840px) {
        .hero {
          grid-template-columns: 1fr;
        }
        .compiler-hero-shell,
        .compiler-lab-grid,
        .compiler-note-grid {
          grid-template-columns: 1fr;
        }
        .demo-inspector-body {
          grid-template-columns: 1fr;
        }
        .compiler-chip-grid {
          grid-template-columns: 1fr;
        }
        .compiler-output-header {
          align-items: flex-start;
        }
      }
    </style>
  </head>
  <body>
    ${renderSiteNav(context.baseUrl)}
    <main>${context.body}</main>
    ${renderSiteFooter(context.baseUrl)}
  </body>
</html>`;
}

function renderLandingPage(context: {
  baseUrl: string;
  checkoutUrl: string | undefined;
  contactEmail: string | undefined;
}): string {
  const checkoutMarkup = context.checkoutUrl
    ? `<a class="primary" href="${escapeHtml(context.checkoutUrl)}">Buy API access for Rs 499</a>`
    : `<span class="ghost">Checkout link available after billing is configured</span>`;
  const contactMarkup = context.contactEmail
    ? `<p class="meta">Support: <a href="mailto:${escapeHtml(context.contactEmail)}">${escapeHtml(context.contactEmail)}</a></p>`
    : "";
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: ROOT_FAQ.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer
      }
    }))
  };
  const softwareJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Schema Gateway Pro",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web",
    description:
      "Provider-portable structured output normalization and schema linting for OpenAI, Gemini, Anthropic, Ollama, and framework wrappers.",
    offers: {
      "@type": "Offer",
      price: "499",
      priceCurrency: "INR",
      url: context.checkoutUrl ?? `${context.baseUrl}/pricing`
    }
  };

  return renderMarketingPage({
    baseUrl: context.baseUrl,
    path: "/",
    title: "Schema Gateway Pro | Structured Output Portability API",
    description:
      "Stop rewriting JSON Schema for every model vendor. Schema Gateway lints, normalizes, and signs structured outputs across OpenAI, Gemini, Anthropic, Ollama, and LangChain-style wrappers.",
    jsonLd: [softwareJsonLd, faqJsonLd],
    body: `<section class="panel hero">
        <article class="stack">
          <div class="eyebrow">Structured output portability for AI teams</div>
          <h1>Stop rewriting one schema for every model vendor.</h1>
          <p>
            Schema Gateway exists for the moment when your JSON Schema passes local validation but
            breaks under OpenAI strict mode, Gemini subset handling, Anthropic compatibility mode,
            or local-model wrappers. We lint the schema, rewrite safe provider variants, normalize
            malformed payloads, and return signed results for production pipelines.
          </p>
          <div class="actions">
            <a class="primary" href="${escapeHtml(context.baseUrl)}/compiler#demo">Run free live demo</a>
            ${checkoutMarkup}
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/compare">See provider comparisons</a>
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/compiler">Compile provider payloads</a>
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/install">Install from GitHub</a>
            <a class="secondary" href="${escapeHtml(PUBLIC_REPO_URL)}">GitHub</a>
          </div>
          <div class="pill-row">
            <span class="pill">OpenAI strict schema fixes</span>
            <span class="pill">Gemini propertyOrdering support</span>
            <span class="pill">Anthropic compatibility warnings</span>
            <span class="pill">Ollama validation guardrails</span>
          </div>
        </article>
        <aside class="card stack">
          <div class="eyebrow">Free first, paid when shared enforcement matters</div>
          <h3>What you can use today</h3>
          <ul class="list">
            <li>Free local CLI and SDK for schema validation and JSON repair</li>
            <li>Portable schema linting across OpenAI, Gemini, Anthropic, and Ollama</li>
            <li>Schema compiler that generates provider-ready request fragments</li>
            <li>Reusable GitHub Action for CI summaries on every pull request</li>
            <li>Paid stateless access claims via Polar when you need a shared API</li>
          </ul>
          <div class="section">
            ${renderCodeBlock(`schema-gateway lint --schema ./schema.json --target openai,gemini`)}
          </div>
          <p class="meta">Base URL: <code>${escapeHtml(context.baseUrl)}</code></p>
          ${contactMarkup}
        </aside>
      </section>
      <section class="panel section">
        <h2>Why teams search for this</h2>
        <table class="matrix">
          <thead>
            <tr>
              <th>Provider</th>
              <th>What breaks</th>
              <th>What Schema Gateway does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>OpenAI</td>
              <td>Strict structured outputs reject schemas that look valid but keep optional fields or permissive objects.</td>
              <td>Rewrites required and nullable fields, closes object shapes, and scores strict compatibility.</td>
            </tr>
            <tr>
              <td>Gemini</td>
              <td>Structured output supports a subset of JSON Schema and Gemini 2.0 needs explicit <code>propertyOrdering</code>.</td>
              <td>Adds provider-specific ordering and flags subset-only schema drift.</td>
            </tr>
            <tr>
              <td>Anthropic compatibility</td>
              <td>The OpenAI compatibility layer is convenient, but strict guarantees do not map cleanly.</td>
              <td>Flags compatibility-mode risks before teams assume schema conformance.</td>
            </tr>
            <tr>
              <td>Ollama</td>
              <td>Local structured output is useful, but local and hosted providers still diverge.</td>
              <td>Keeps one portability report and validation layer across local and hosted runtimes.</td>
            </tr>
          </tbody>
        </table>
      </section>
      <section class="grid section">
        ${COMPARE_PAGES.map(
          (page) => `<article class="card">
              <div class="eyebrow">${escapeHtml(page.shortTitle)} compatibility</div>
              <h3>${escapeHtml(page.title)}</h3>
              <p class="meta">${escapeHtml(page.description)}</p>
              <div class="actions">
                <a class="secondary" href="${escapeHtml(context.baseUrl)}/compare/${escapeHtml(page.slug)}">Open page</a>
              </div>
            </article>`
        ).join("")}
      </section>
      <section class="grid section">
        <article class="panel">
          <h2>Free local workflow</h2>
          <p>Developers can lint and validate locally before buying anything, even before npm auth exists.</p>
          ${renderCodeBlock(`${PUBLIC_INSTALL_COMMAND}
schema-gateway validate --schema ./schema.json --payload ./payload.json
schema-gateway lint --schema ./schema.json --target openai,gemini,anthropic,ollama`)}
        </article>
        <article class="panel">
          <h2>Paid claim flow</h2>
          <p>Buy access once, then claim a signed access key from the paid Polar order.</p>
          ${renderCodeBlock(`curl -X POST ${context.baseUrl}/v1/access/polar/claim \\
  -H 'content-type: application/json' \\
  -d '{"orderId":"polar_order_id","email":"you@example.com"}'`)}
        </article>
      </section>
      <section class="grid section">
        <article class="panel">
          <h2>Schema compiler</h2>
          <p>Generate provider-ready request fragments instead of manually translating JSON Schema into four different SDK shapes.</p>
          ${renderCodeBlock(PUBLIC_COMPILE_SNIPPET)}
          <div class="actions">
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/compiler">Open compiler guide</a>
          </div>
        </article>
        <article class="panel">
          <h2>GitHub CI check</h2>
          <p>Drop Schema Gateway into CI and get a job summary with compatibility scores, top issues, and a generated request snippet.</p>
          ${renderCodeBlock(PUBLIC_CI_SNIPPET)}
          <div class="actions">
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/ci">Open CI guide</a>
          </div>
        </article>
      </section>
      <section class="panel section" id="faq">
        <h2>FAQ</h2>
        ${ROOT_FAQ.map(
          (item) => `<div class="faq-item">
              <h3>${escapeHtml(item.question)}</h3>
              <p>${escapeHtml(item.answer)}</p>
            </div>`
        ).join("")}
      </section>`
  });
}

function renderInstallPage(baseUrl: string): string {
  return renderMarketingPage({
    baseUrl,
    path: "/install",
    title: "Install Schema Gateway from GitHub Releases",
    description:
      "Install Schema Gateway directly from a public GitHub release tarball. No npm registry login or paid marketplace account required.",
    body: `<section class="grid">
        <article class="panel stack">
          <div class="eyebrow">GitHub-first distribution</div>
          <h1>Install Schema Gateway straight from the public release.</h1>
          <p>
            Schema Gateway is installable today without waiting for npm publishing. Install the
            public core and SDK release tarballs in one npm command and start linting locally.
          </p>
          ${renderCodeBlock(PUBLIC_INSTALL_COMMAND)}
          <div class="actions">
            <a class="primary" href="${escapeHtml(PUBLIC_REPO_URL)}/releases/tag/${PUBLIC_RELEASE_TAG}">Open release assets</a>
            <a class="secondary" href="${escapeHtml(PUBLIC_REPO_URL)}/releases/tag/${PUBLIC_RELEASE_TAG}">View release ${escapeHtml(PUBLIC_RELEASE_TAG)}</a>
          </div>
        </article>
        <article class="panel stack">
          <div class="eyebrow">Quick check</div>
          <h2>Run a real portability lint immediately.</h2>
          ${renderCodeBlock(`schema-gateway lint --schema ./schema.json --target openai,gemini,anthropic,ollama`)}
          <p class="meta">Current installer: <code>${escapeHtml(PUBLIC_SDK_INSTALL_URL)}</code></p>
        </article>
      </section>
      <section class="grid section">
        <article class="panel">
          <h2>Why this matters</h2>
          <ul class="list">
            <li>No npm auth is required to evaluate the product locally.</li>
            <li>Two public release assets install cleanly in a single npm command.</li>
            <li>Teams can test the free workflow before buying the remote API.</li>
          </ul>
        </article>
        <article class="panel">
          <h2>Upgrade path</h2>
          <ul class="list">
            <li>Use the local CLI for free validation and repair.</li>
            <li>Buy starter access when you need the shared API and signed remote reports.</li>
            <li>Claim a key from a Polar order via <code>POST /v1/access/polar/claim</code>.</li>
          </ul>
        </article>
      </section>`
  });
}

function renderCompilerPage(baseUrl: string): string {
  const demoSchema = JSON.stringify(DEMO_SAMPLE_SCHEMA, null, 2);
  const previewSnippet = `{
  "openai": {
    "text": {
      "format": {
        "type": "json_schema",
        "name": "schema_gateway_output"
      }
    }
  },
  "gemini": {
    "generationConfig": {
      "responseMimeType": "application/json"
    }
  }
}`;
  return renderMarketingPage({
    baseUrl,
    path: "/compiler",
    title: "Schema Gateway Compiler | Generate provider-ready payloads",
    description:
      "Compile one JSON schema into provider-ready request fragments for OpenAI, Gemini, Anthropic, and Ollama.",
    body: `<section class="panel compiler-hero-shell">
        <article class="compiler-hero-copy stack">
          <div class="eyebrow compiler-kicker">Schema compiler</div>
          <h1>One schema. Four runtimes. Zero hand-mapping.</h1>
          <p class="compiler-lede">
            Schema Gateway compiles a single JSON Schema into ready-to-paste request payloads for
            OpenAI, Gemini, Anthropic, and Ollama. Use it locally for free, then move to the shared
            signed API when CI or multiple engineers need the same compiler surface.
          </p>
          <div class="compiler-stat-row">
            <div class="compiler-stat">
              <strong>4 providers</strong>
              <span>from one source schema</span>
            </div>
            <div class="compiler-stat">
              <strong>Live demo</strong>
              <span>hosted proof before checkout</span>
            </div>
            <div class="compiler-stat">
              <strong>Signed output</strong>
              <span>when the shared API matters</span>
            </div>
          </div>
          ${renderCodeBlock(PUBLIC_COMPILE_SNIPPET)}
          <div class="actions">
            <a class="primary" href="${escapeHtml(baseUrl)}/compiler#demo">Run free live demo</a>
            <a class="secondary" href="${escapeHtml(baseUrl)}/install">Install the CLI</a>
            <a class="secondary" href="${escapeHtml(baseUrl)}/pricing">Buy full API</a>
          </div>
          <div class="compiler-hero-note">
            Public release <a href="${escapeHtml(PUBLIC_REPO_URL)}/releases/tag/${PUBLIC_RELEASE_TAG}">${escapeHtml(PUBLIC_RELEASE_TAG)}</a> is live, and the hosted compiler is available at <code>POST /v1/compile</code>.
          </div>
        </article>
        <aside class="compiler-preview">
          <div class="eyebrow">Compiled preview</div>
          <div class="compiler-chip-grid">
            <div class="compiler-chip">
              <strong>OpenAI</strong>
              <span>Responses and Chat Completions fragments</span>
            </div>
            <div class="compiler-chip">
              <strong>Gemini</strong>
              <span><code>responseJsonSchema</code> plus ordering fixes</span>
            </div>
            <div class="compiler-chip">
              <strong>Anthropic</strong>
              <span>Native <code>tools</code> definitions, not compatibility guesswork</span>
            </div>
            <div class="compiler-chip">
              <strong>Ollama</strong>
              <span><code>format</code> payloads with stable inference hints</span>
            </div>
          </div>
          <div class="compiler-window">
            <div class="compiler-window-bar">
              <span class="compiler-window-dot"></span>
              <span class="compiler-window-dot"></span>
              <span class="compiler-window-dot"></span>
              <span class="compiler-window-label">Compiled preview</span>
            </div>
            ${renderCodeBlock(previewSnippet)}
          </div>
          <p class="meta">
            Need a shared compiler for CI or multiple teams? The paid API returns the same compiled
            bundle with a signature and stable base URL.
          </p>
        </aside>
      </section>
      <section class="panel compiler-lab section" id="demo">
        <div class="compiler-lab-head">
          <div class="compiler-lab-copy stack">
            <div class="eyebrow compiler-kicker">Interactive playground</div>
            <h2>Try the hosted compiler before you pay.</h2>
            <p>
              This public demo is intentionally limited, but it is real: compile only, small
              schemas, no API key, signed response. The goal is simple: the product should prove
              itself before anyone touches checkout.
            </p>
          </div>
          <div class="compiler-limit-row">
            <span class="compiler-limit">12 KB request</span>
            <span class="compiler-limit">6 KB schema</span>
            <span class="compiler-limit">Compile only</span>
          </div>
        </div>
        <div class="compiler-lab-grid">
          <form class="compiler-form-shell form-grid" id="demo-compile-form">
            <div class="compiler-form-head">
              <div class="compiler-form-title">
                <span class="eyebrow compiler-kicker">Source schema</span>
                <p>Pick targets, adjust the schema, and run the compiler.</p>
              </div>
              <div class="compiler-limit-row">
                <span class="compiler-limit">No signup</span>
                <span class="compiler-limit">Signed result</span>
              </div>
            </div>
            <label class="field" for="demo-targets">
              <span class="field-label">Targets</span>
              <input class="demo-hidden-input" id="demo-targets" name="targets" value="${escapeHtml(DEMO_DEFAULT_TARGETS.join(","))}" spellcheck="false">
              <div class="demo-target-picker" role="group" aria-label="Select target providers">
                <button class="demo-target-toggle is-active" type="button" data-demo-target="openai" aria-pressed="true">OpenAI</button>
                <button class="demo-target-toggle is-active" type="button" data-demo-target="gemini" aria-pressed="true">Gemini</button>
                <button class="demo-target-toggle" type="button" data-demo-target="anthropic" aria-pressed="false">Anthropic</button>
                <button class="demo-target-toggle" type="button" data-demo-target="ollama" aria-pressed="false">Ollama</button>
              </div>
            </label>
            <label class="field" for="demo-schema">
              <span class="field-label">Schema JSON</span>
              <textarea id="demo-schema" name="schema" spellcheck="false">${escapeHtml(demoSchema)}</textarea>
            </label>
            <div class="compiler-run-row">
              <button class="primary" id="demo-run" type="submit">Run free demo</button>
              <button class="secondary" id="demo-use-sample" type="button">Use sample schema</button>
              <a class="secondary" href="${escapeHtml(baseUrl)}/pricing">Buy full API</a>
            </div>
          </form>
          <div class="compiler-output-shell">
            <div class="compiler-output-header">
              <div class="stack">
                <div class="eyebrow compiler-kicker">Live output</div>
                <div class="compiler-output-caption">
                  The sample run loads automatically so the page feels alive instead of empty.
                </div>
              </div>
              <p class="meta" data-variant="loading" id="demo-status">Loading a sample compile run...</p>
            </div>
            <div class="demo-summary" id="demo-summary"></div>
            <details class="demo-raw-shell">
              <summary>Show raw demo bundle</summary>
              <pre><code id="demo-raw-output"></code></pre>
            </details>
            <div class="compiler-output-caption">
              Paid access unlocks the signed shared endpoints for <code>/v1/compile</code>,
              <code>/v1/lint</code>, and <code>/v1/normalize</code>.
            </div>
          </div>
        </div>
      </section>
      <section class="panel section">
        <div class="compiler-lab-head">
          <div class="compiler-lab-copy stack">
            <div class="eyebrow compiler-kicker">Upgrade path</div>
            <h2>Evaluate locally. Move to the shared API when the team needs it.</h2>
          </div>
        </div>
        <div class="compiler-lab-grid">
          <article class="compiler-note-card">
            <div class="eyebrow">Local CLI</div>
            <p>Install from GitHub and run the compiler locally with no registry friction.</p>
            ${renderCodeBlock(PUBLIC_INSTALL_COMMAND)}
          </article>
          <article class="compiler-note-card">
            <div class="eyebrow">Hosted API</div>
            <p>Use the same compiler behind a stable signed endpoint once CI or multiple engineers depend on it.</p>
            ${renderCodeBlock(`curl -X POST ${baseUrl}/v1/compile \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: sk_live...' \\
  -d '{"schema":{"type":"object","properties":{"city":{"type":"string"}}},"targets":["openai","gemini"]}'`)}
          </article>
        </div>
      </section>
      ${renderCompilerDemoScript(baseUrl)}`
  });
}

function renderCiPage(baseUrl: string): string {
  return renderMarketingPage({
    baseUrl,
    path: "/ci",
    title: "Schema Gateway CI | GitHub Action for structured outputs",
    description:
      "Use Schema Gateway as a GitHub Action to lint schemas in CI and publish provider portability summaries on every workflow run.",
    body: `<section class="grid">
        <article class="panel stack">
          <div class="eyebrow">GitHub Action</div>
          <h1>Run Schema Gateway on every pull request.</h1>
          <p>
            The free GitHub Action lints one schema across provider targets, writes a job summary,
            and surfaces the first generated request snippet so teams can fix breakage before it
            lands in production.
          </p>
          ${renderCodeBlock(PUBLIC_CI_SNIPPET)}
          <div class="actions">
            <a class="primary" href="${escapeHtml(PUBLIC_REPO_URL)}/tree/${escapeHtml(PUBLIC_ACTION_REF)}/.github/actions/portability-check">View action source</a>
            <a class="secondary" href="${escapeHtml(baseUrl)}/compiler">See compiler output</a>
          </div>
        </article>
        <article class="panel stack">
          <div class="eyebrow">Job summary output</div>
          <ul class="list">
            <li>Compatibility status per provider</li>
            <li>Error, warning, and info counts</li>
            <li>Top schema issues with codes</li>
            <li>A generated request snippet for the first provider variant</li>
          </ul>
        </article>
      </section>`
  });
}

function renderCompareIndexPage(baseUrl: string): string {
  return renderMarketingPage({
    baseUrl,
    path: "/compare",
    title: "Schema Gateway Comparisons | OpenAI, Gemini, Anthropic, Ollama",
    description:
      "Provider-specific structured output comparison pages for OpenAI, Gemini, Anthropic compatibility mode, and Ollama.",
    body: `<section class="panel">
        <div class="eyebrow">Provider comparisons</div>
        <h1>Vendor-specific schema drift, documented page by page.</h1>
        <p>
          These pages target the exact compatibility failures teams hit when they try to reuse one
          JSON Schema across multiple model providers and SDK layers.
        </p>
      </section>
      <section class="grid section">
        ${COMPARE_PAGES.map(
          (page) => `<article class="card stack">
              <div class="eyebrow">${escapeHtml(page.shortTitle)}</div>
              <h3>${escapeHtml(page.title)}</h3>
              <p class="meta">${escapeHtml(page.description)}</p>
              <div class="actions">
                <a class="secondary" href="${escapeHtml(baseUrl)}/compare/${escapeHtml(page.slug)}">Read comparison</a>
              </div>
            </article>`
        ).join("")}
      </section>`
  });
}

function renderComparePage(baseUrl: string, page: ComparePage): string {
  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.title,
    description: page.description,
    url: `${baseUrl}/compare/${page.slug}`
  };

  return renderMarketingPage({
    baseUrl,
    path: `/compare/${page.slug}`,
    title: `${page.title} | Schema Gateway`,
    description: page.description,
    jsonLd: articleJsonLd,
    body: `<section class="panel hero">
        <article class="stack">
          <div class="eyebrow">${escapeHtml(page.shortTitle)} structured output guide</div>
          <h1>${escapeHtml(page.headline)}</h1>
          <p>${escapeHtml(page.intro)}</p>
          <div class="pill-row">
            ${page.searchTerms.map((term) => `<span class="pill">${escapeHtml(term)}</span>`).join("")}
          </div>
          <div class="actions">
            <a class="primary" href="${escapeHtml(baseUrl)}/pricing">Buy access</a>
            <a class="secondary" href="${escapeHtml(baseUrl)}/compare">All comparisons</a>
          </div>
        </article>
        <aside class="card stack">
          <h3>Schema Gateway move</h3>
          <p class="meta">${escapeHtml(page.description)}</p>
          ${renderCodeBlock(page.snippet)}
        </aside>
      </section>
      <section class="grid section">
        <article class="panel">
          <h2>What breaks</h2>
          <ul class="list">
            ${page.constraints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </article>
        <article class="panel">
          <h2>What Schema Gateway fixes</h2>
          <ul class="list">
            ${page.fixes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </article>
      </section>
      <section class="panel section">
        <h2>Official references</h2>
        <ul class="list">
          ${page.docs
            .map(
              (doc) =>
                `<li><a href="${escapeHtml(doc.url)}">${escapeHtml(doc.label)}</a></li>`
            )
            .join("")}
        </ul>
      </section>`
  });
}

function renderPricingPage(context: {
  baseUrl: string;
  checkoutUrl: string | undefined;
}): string {
  const checkoutMarkup = context.checkoutUrl
    ? `<a class="primary" href="${escapeHtml(context.checkoutUrl)}">Buy starter access for Rs 499</a>`
    : `<span class="ghost">Checkout not configured</span>`;

  return renderMarketingPage({
    baseUrl: context.baseUrl,
    path: "/pricing",
    title: "Schema Gateway Pricing | Free local SDK, Rs 499 starter access",
    description:
      "Free local SDK and CLI for schema validation, with a paid Rs 499 starter pack for shared API access and signed portability reports.",
    body: `<section class="grid">
        <article class="panel">
          <div class="eyebrow">Free tier</div>
          <h1>Use the SDK locally for free.</h1>
          <ul class="list">
            <li>Local schema validation and JSON repair</li>
            <li>Provider-portability linting in the CLI and SDK</li>
            <li>Installable from a public GitHub release with no npm auth</li>
          </ul>
          <div class="section">
            ${renderCodeBlock(`${PUBLIC_INSTALL_COMMAND}
schema-gateway lint --schema ./schema.json --target openai,gemini`)}
          </div>
          <div class="actions">
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/install">Install guide</a>
          </div>
        </article>
        <article class="panel">
          <div class="eyebrow">Paid starter</div>
          <h2>Rs 499 one-time starter access</h2>
          <p>
            Best for teams that need a shared API endpoint, signed lint reports, and remote
            normalization behind a stable base URL.
          </p>
          <ul class="list">
            <li>Signed compiler bundles from <code>POST /v1/compile</code></li>
            <li>Signed portability reports from <code>POST /v1/lint</code></li>
            <li>Signed normalization results from <code>POST /v1/normalize</code></li>
            <li>Self-serve claim flow after a Polar purchase</li>
          </ul>
          <div class="actions">
            ${checkoutMarkup}
            <a class="secondary" href="${escapeHtml(context.baseUrl)}/openapi.json">OpenAPI spec</a>
          </div>
        </article>
      </section>`
  });
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

function countUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function describeProviderSummary(
  providers: Array<{ provider: string; compatible: boolean; score: number }>
): string {
  return providers
    .map((provider) => `${provider.provider}:${provider.compatible ? "ok" : "fix"}:${provider.score}`)
    .join("|");
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

app.get("/compare", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.html(renderCompareIndexPage(baseUrl));
});

app.get("/compare/:slug", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  const slug = context.req.param("slug");
  const page = COMPARE_PAGES.find((entry) => entry.slug === slug);

  if (!page) {
    return context.text("Not found", 404);
  }

  return context.html(renderComparePage(baseUrl, page));
});

app.get("/compiler", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.html(renderCompilerPage(baseUrl));
});

app.get("/ci", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.html(renderCiPage(baseUrl));
});

app.get("/install", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.html(renderInstallPage(baseUrl));
});

app.get("/pricing", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.html(
    renderPricingPage({
      baseUrl,
      checkoutUrl: context.env.CHECKOUT_URL
    })
  );
});

app.get("/robots.txt", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  return context.text(`User-agent: *
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
`, 200, {
    "content-type": "text/plain; charset=utf-8"
  });
});

app.get("/llms.txt", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  const compareLines = COMPARE_PAGES.map(
    (page) => `- ${page.title}: ${baseUrl}/compare/${page.slug}`
  ).join("\n");

  return context.text(
    `# Schema Gateway Pro

Schema Gateway is a developer API for structured output portability across OpenAI, Gemini, Anthropic compatibility mode, Ollama, and framework wrappers.

Primary pages:
- Home: ${baseUrl}/
- Comparisons: ${baseUrl}/compare
- Compiler: ${baseUrl}/compiler
- GitHub CI: ${baseUrl}/ci
- Install: ${baseUrl}/install
- Pricing: ${baseUrl}/pricing
- OpenAPI: ${baseUrl}/openapi.json

Provider comparison pages:
${compareLines}

Public demo endpoints:
- POST /v1/demo/compile

Primary paid endpoints:
- POST /v1/compile
- POST /v1/lint
- POST /v1/normalize
- POST /v1/access/polar/claim
`,
    200,
    {
      "content-type": "text/plain; charset=utf-8"
    }
  );
});

app.get("/sitemap.xml", (context) => {
  const baseUrl = new URL(context.req.url).origin;
  const routes = [
    "/",
    "/compare",
    "/compiler",
    "/ci",
    "/install",
    "/pricing",
    ...COMPARE_PAGES.map((page) => `/compare/${page.slug}`)
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes
  .map(
    (path) => `  <url>
    <loc>${escapeHtml(`${baseUrl}${path === "/" ? "" : path}`)}</loc>
  </url>`
  )
  .join("\n")}
</urlset>`;

  return context.text(xml, 200, {
    "content-type": "application/xml; charset=utf-8"
  });
});

app.get(`/${PUBLIC_INDEXNOW_KEY}.txt`, (context) => {
  return context.text(PUBLIC_INDEXNOW_KEY, 200, {
    "content-type": "text/plain; charset=utf-8"
  });
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

app.post("/v1/demo/compile", async (context) => {
  const rawBody = await context.req.text();
  if (countUtf8Bytes(rawBody) > DEMO_MAX_BODY_BYTES) {
    return context.json(
      {
        error: `Demo requests are limited to ${DEMO_MAX_BODY_BYTES.toLocaleString()} bytes.`
      },
      413
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return context.json(
      {
        error: "The demo endpoint expects valid JSON."
      },
      400
    );
  }

  const body = CompileBodySchema.parse(parsedBody);
  const schemaBytes = countUtf8Bytes(JSON.stringify(body.schema));
  if (schemaBytes > DEMO_MAX_SCHEMA_BYTES) {
    return context.json(
      {
        error: `Demo schemas are limited to ${DEMO_MAX_SCHEMA_BYTES.toLocaleString()} bytes.`
      },
      413
    );
  }

  const targets =
    body.targets && body.targets.length > 0 ? body.targets : DEMO_DEFAULT_TARGETS;
  const bundle = await compileStructuredOutputSchema({
    schema: body.schema,
    targets: targets as SchemaPortabilityTarget[],
    ...(body.name ? { name: body.name } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.prompt ? { prompt: body.prompt } : {})
  });
  const signature = await createSignedEnvelope(context.env.ISSUER_SECRET, {
    type: "demo_compile",
    schemaHash: bundle.schemaHash,
    name: bundle.name,
    providers: describeProviderSummary(
      bundle.providers.map((provider) => ({
        provider: provider.provider,
        compatible: provider.compatible,
        score: provider.score
      }))
    ),
    limits: {
      maxBodyBytes: DEMO_MAX_BODY_BYTES,
      maxSchemaBytes: DEMO_MAX_SCHEMA_BYTES
    }
  });

  return context.json({
    ...bundle,
    demo: true,
    signature,
    limits: {
      maxBodyBytes: DEMO_MAX_BODY_BYTES,
      maxSchemaBytes: DEMO_MAX_SCHEMA_BYTES
    }
  });
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

app.use("/v1/compile", requireApiKey);
app.use("/v1/normalize", requireApiKey);
app.use("/v1/lint", requireApiKey);

app.post("/v1/compile", async (context) => {
  const body = CompileBodySchema.parse(await context.req.json());
  const accessPayload = context.get("accessPayload");
  const keyId = context.get("keyId");
  const record = context.get("keyRecord");
  const bundle = await compileStructuredOutputSchema({
    schema: body.schema,
    ...(body.targets ? { targets: body.targets as SchemaPortabilityTarget[] } : {}),
    ...(body.name ? { name: body.name } : {}),
    ...(body.description ? { description: body.description } : {}),
    ...(body.prompt ? { prompt: body.prompt } : {})
  });
  const updatedRecord = await spendCredit(context.env, record);

  const signature = await createSignedEnvelope(context.env.ISSUER_SECRET, {
    keyId,
    schemaHash: bundle.schemaHash,
    name: bundle.name,
    providers: bundle.providers.map((provider) => ({
      provider: provider.provider,
      compatible: provider.compatible,
      score: provider.score,
      variants: provider.variants.map((variant) => variant.key)
    })),
    remainingCredits: accessPayload ? null : updatedRecord.credits,
    expiresAt: accessPayload?.expiresAt
  });

  return context.json({
    ...bundle,
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
