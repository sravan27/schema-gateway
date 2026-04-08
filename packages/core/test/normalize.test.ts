import { describe, expect, it } from "vitest";

import { normalizeStructuredOutput } from "../src/index.js";

describe("normalizeStructuredOutput", () => {
  it("extracts JSON from tool-call arguments and coerces primitives", async () => {
    const result = await normalizeStructuredOutput({
      schema: {
        type: "object",
        properties: {
          city: { type: "string" },
          count: { type: "integer" }
        },
        required: ["city", "count"],
        additionalProperties: false
      },
      payload: {
        tool_calls: [
          {
            function: {
              name: "lookup_city",
              arguments: "{\"city\":\"Paris\",\"count\":\"2\"}"
            }
          }
        ]
      }
    });

    expect(result.valid).toBe(true);
    expect(result.toolCalls[0]?.name).toBe("lookup_city");
    expect(result.normalized).toEqual({
      city: "Paris",
      count: 2
    });
  });
});
