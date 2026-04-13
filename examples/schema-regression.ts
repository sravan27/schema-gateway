import { SchemaGatewayClient } from "@apex-value/schema-gateway";

const client = new SchemaGatewayClient();

const diff = await client.diffLocal({
  baselineSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string" }
    },
    required: ["city"],
    additionalProperties: false
  },
  candidateSchema: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string" },
      temperatureC: { type: "number" }
    },
    required: ["city", "temperatureC"],
    additionalProperties: false
  },
  targets: ["openai", "gemini", "anthropic", "ollama"]
});

console.log(JSON.stringify(diff, null, 2));
