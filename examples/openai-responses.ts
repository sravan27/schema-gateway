import { SchemaGatewayClient } from "@apex-value/schema-gateway";

const client = new SchemaGatewayClient();

const result = await client.normalizeLocal({
  provider: "openai",
  schema: {
    type: "object",
    properties: {
      city: { type: "string" },
      units: { type: "string" },
      days: { type: "integer" }
    },
    required: ["city", "units", "days"],
    additionalProperties: false
  },
  payload: {
    output: [
      {
        type: "function_call",
        name: "weather_lookup",
        arguments: "{\"city\":\"Berlin\",\"units\":\"metric\",\"days\":\"3\"}"
      }
    ]
  }
});

console.log(JSON.stringify(result, null, 2));
