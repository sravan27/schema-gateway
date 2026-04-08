import { SchemaGatewayClient } from "@apex-value/schema-gateway";

const client = new SchemaGatewayClient();

const report = await client.lintLocal({
  schema: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string" },
      days: { type: "integer" }
    },
    required: ["city", "days"]
  },
  targets: ["openai", "gemini", "anthropic", "ollama"]
});

console.log(JSON.stringify(report, null, 2));
