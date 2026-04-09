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
      :root {
        color-scheme: light;
        --bg: #f4efe5;
        --panel: #fffdf8;
        --ink: #172126;
        --muted: #54616b;
        --accent: #0f766e;
        --accent-ink: #f6fffd;
        --border: #d8d2c7;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top right, rgba(15, 118, 110, 0.12), transparent 30%),
          linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
        color: var(--ink);
      }
      a {
        color: inherit;
      }
      .site-nav,
      .site-footer {
        max-width: 1120px;
        margin: 0 auto;
        padding: 22px 20px;
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
        letter-spacing: -0.03em;
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
        padding: 18px 20px 80px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 14px 50px rgba(23, 33, 38, 0.08);
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
        min-height: 48px;
        border-radius: 999px;
        padding: 0 18px;
        text-decoration: none;
        font-weight: 600;
      }
      .primary {
        background: var(--accent);
        color: var(--accent-ink);
      }
      .secondary {
        border: 1px solid var(--border);
        color: var(--ink);
        background: rgba(255, 255, 255, 0.85);
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
        border-radius: 18px;
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
      @media (max-width: 840px) {
        .hero {
          grid-template-columns: 1fr;
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
  return renderMarketingPage({
    baseUrl,
    path: "/compiler",
    title: "Schema Gateway Compiler | Generate provider-ready payloads",
    description:
      "Compile one JSON schema into provider-ready request fragments for OpenAI, Gemini, Anthropic, and Ollama.",
    body: `<section class="grid">
        <article class="panel stack">
          <div class="eyebrow">Schema compiler</div>
          <h1>Turn one schema into provider-ready request payloads.</h1>
          <p>
            The compiler takes the same normalized schema report and emits request fragments you can
            paste into OpenAI, Gemini, Anthropic, or Ollama integrations without hand-translating
            each provider's request shape.
          </p>
          ${renderCodeBlock(PUBLIC_COMPILE_SNIPPET)}
          <div class="actions">
            <a class="primary" href="${escapeHtml(baseUrl)}/install">Install the CLI</a>
            <a class="secondary" href="${escapeHtml(PUBLIC_REPO_URL)}/releases/tag/${PUBLIC_RELEASE_TAG}">Open release ${escapeHtml(PUBLIC_RELEASE_TAG)}</a>
          </div>
        </article>
        <article class="panel stack">
          <div class="eyebrow">What comes out</div>
          <ul class="list">
            <li>OpenAI Responses and Chat Completions fragments</li>
            <li>Gemini <code>generationConfig.responseJsonSchema</code> payloads</li>
            <li>Anthropic native <code>tools</code> definitions instead of compatibility guesswork</li>
            <li>Ollama <code>format</code> plus deterministic <code>temperature: 0</code> hints</li>
          </ul>
          <div class="section">
            <p class="meta">Need a shared hosted compiler for CI or multiple teams?</p>
            ${renderCodeBlock(`curl -X POST ${baseUrl}/v1/compile \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: sk_live...' \\
  -d '{"schema":{"type":"object","properties":{"city":{"type":"string"}}},"targets":["openai","gemini"]}'`)}
          </div>
        </article>
      </section>`
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
