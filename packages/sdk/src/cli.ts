#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import type { SchemaPortabilityTarget, SupportedProvider } from "@apex-value/schema-gateway-core";

import { buildPurchaseMetadata, SchemaGatewayClient } from "./index.js";

type Command = "validate" | "redeem" | "commitment" | "lint" | "claim" | "compile";

interface CliOptions {
  [key: string]: string | boolean | undefined;
}

function usage(): string {
  return [
    "Usage:",
    "  schema-gateway validate --schema ./schema.json --payload ./payload.json [--provider openai]",
    "  schema-gateway validate --schema ./schema.json --payload ./payload.txt --remote --api-key sk_live... [--base-url https://worker.example]",
    "  schema-gateway lint --schema ./schema.json [--target openai,gemini]",
    "  schema-gateway lint --schema ./schema.json --remote --api-key sk_live... [--base-url https://worker.example]",
    "  schema-gateway compile --schema ./schema.json [--target openai,gemini] [--name weather_response]",
    "  schema-gateway claim --order-id polar_order... --email you@example.com [--base-url https://worker.example]",
    "  schema-gateway redeem --tx-hash 0x... --label router-service [--base-url https://worker.example]",
    "  schema-gateway commitment --label router-service",
    "",
    "Flags:",
    "  --schema     Path to a JSON schema file",
    "  --payload    Path to a payload file, or '-' to read stdin",
    "  --provider   generic | openai | langchain | ollama",
    "  --remote     Call the paid API instead of local normalization",
    "  --api-key    API key for remote normalization",
    "  --base-url   Worker base URL",
    "  --target     Comma-separated portability targets: openai, gemini, anthropic, ollama",
    "  --name       Schema/tool name used in generated provider snippets",
    "  --prompt     User prompt text to embed in generated request snippets",
    "  --description Tool/schema description for generated provider snippets",
    "  --order-id   Polar order ID for access claiming",
    "  --email      Buyer email for Polar access claiming",
    "  --tx-hash    Purchase transaction hash for key redemption",
    "  --label      Human-readable service label used to derive the key commitment"
  ].join("\n");
}

function parseArgs(argv: string[]): { command: Command | null; options: CliOptions } {
  const [commandToken, ...rest] = argv;
  const options: CliOptions = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token || !token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  if (
    commandToken === "validate" ||
    commandToken === "redeem" ||
    commandToken === "commitment" ||
    commandToken === "lint" ||
    commandToken === "claim" ||
    commandToken === "compile"
  ) {
    return { command: commandToken, options };
  }

  return { command: null, options };
}

async function readFileOrStdin(inputPath: string): Promise<string> {
  if (inputPath === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  return fs.readFile(path.resolve(process.cwd(), inputPath), "utf8");
}

function parseMaybeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function runValidate(options: CliOptions): Promise<void> {
  const schemaPath = options.schema;
  const payloadPath = options.payload;

  if (typeof schemaPath !== "string" || typeof payloadPath !== "string") {
    throw new Error("`validate` requires both --schema and --payload.");
  }

  const [schemaRaw, payloadRaw] = await Promise.all([
    readFileOrStdin(schemaPath),
    readFileOrStdin(payloadPath)
  ]);

  const provider =
    typeof options.provider === "string"
      ? (options.provider as SupportedProvider)
      : undefined;

  const request = {
    schema: JSON.parse(schemaRaw) as Record<string, unknown>,
    payload: parseMaybeJson(payloadRaw),
    ...(provider ? { provider } : {})
  };

  const client = new SchemaGatewayClient({
    ...(typeof options["api-key"] === "string" ? { apiKey: options["api-key"] } : {}),
    ...(typeof options["base-url"] === "string" ? { baseUrl: options["base-url"] } : {})
  });

  const result = options.remote
    ? await client.normalizeRemote(request)
    : await client.normalizeLocal(request);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseTargets(raw: string | boolean | undefined): SchemaPortabilityTarget[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }

  const targets = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is SchemaPortabilityTarget =>
      ["openai", "gemini", "anthropic", "ollama"].includes(entry)
    );

  return targets.length > 0 ? targets : undefined;
}

async function runLint(options: CliOptions): Promise<void> {
  const schemaPath = options.schema;

  if (typeof schemaPath !== "string") {
    throw new Error("`lint` requires --schema.");
  }

  const schemaRaw = await readFileOrStdin(schemaPath);
  const schema = JSON.parse(schemaRaw) as Record<string, unknown>;
  const targets = parseTargets(options.target);

  const client = new SchemaGatewayClient({
    ...(typeof options["api-key"] === "string" ? { apiKey: options["api-key"] } : {}),
    ...(typeof options["base-url"] === "string" ? { baseUrl: options["base-url"] } : {})
  });

  const result = options.remote
    ? await client.lintRemote({
        schema,
        ...(targets ? { targets } : {})
      })
    : await client.lintLocal({
        schema,
        ...(targets ? { targets } : {})
      });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runCompile(options: CliOptions): Promise<void> {
  const schemaPath = options.schema;

  if (typeof schemaPath !== "string") {
    throw new Error("`compile` requires --schema.");
  }

  const schemaRaw = await readFileOrStdin(schemaPath);
  const schema = JSON.parse(schemaRaw) as Record<string, unknown>;
  const targets = parseTargets(options.target);

  const client = new SchemaGatewayClient();
  const result = await client.compileLocal({
    schema,
    ...(targets ? { targets } : {}),
    ...(typeof options.name === "string" ? { name: options.name } : {}),
    ...(typeof options.prompt === "string" ? { prompt: options.prompt } : {}),
    ...(typeof options.description === "string"
      ? { description: options.description }
      : {})
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runRedeem(options: CliOptions): Promise<void> {
  const txHash = options["tx-hash"];
  const label = options.label;

  if (typeof txHash !== "string" || typeof label !== "string") {
    throw new Error("`redeem` requires both --tx-hash and --label.");
  }

  const client = new SchemaGatewayClient({
    ...(typeof options["base-url"] === "string" ? { baseUrl: options["base-url"] } : {})
  });

  const result = await client.redeemCredits({ txHash: txHash as `0x${string}`, label });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runClaim(options: CliOptions): Promise<void> {
  const orderId = options["order-id"];
  const email = options.email;

  if (typeof orderId !== "string" || typeof email !== "string") {
    throw new Error("`claim` requires both --order-id and --email.");
  }

  const client = new SchemaGatewayClient({
    ...(typeof options["base-url"] === "string" ? { baseUrl: options["base-url"] } : {})
  });

  const result = await client.claimPolarAccess({ orderId, email });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runCommitment(options: CliOptions): Promise<void> {
  const label = options.label;

  if (typeof label !== "string") {
    throw new Error("`commitment` requires --label.");
  }

  const result = await buildPurchaseMetadata(label);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "validate":
      await runValidate(options);
      break;
    case "redeem":
      await runRedeem(options);
      break;
    case "commitment":
      await runCommitment(options);
      break;
    case "lint":
      await runLint(options);
      break;
    case "claim":
      await runClaim(options);
      break;
    case "compile":
      await runCompile(options);
      break;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
