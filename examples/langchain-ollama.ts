import { SchemaGatewayClient } from "@apex-value/schema-gateway";

const client = new SchemaGatewayClient();

const result = await client.normalizeLocal({
  provider: "langchain",
  schema: {
    type: "object",
    properties: {
      answer: { type: "string" },
      confidence: { type: "number" }
    },
    required: ["answer", "confidence"],
    additionalProperties: false
  },
  payload: {
    additional_kwargs: {
      tool_calls: [
        {
          function: {
            name: "return_structured_answer",
            arguments:
              "```json\n{\"answer\":\"supports response_format\",\"confidence\":\"0.92\"}\n```"
          }
        }
      ]
    }
  }
});

console.log(JSON.stringify(result, null, 2));
