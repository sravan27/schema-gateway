import { describe, expect, it } from "vitest";

import { compileStructuredOutputSchema, lintStructuredOutputSchema } from "../src/index.js";

describe("lintStructuredOutputSchema", () => {
  it("rewrites OpenAI schemas to strict-compatible required nullable objects", async () => {
    const report = await lintStructuredOutputSchema({
      schema: {
        type: "object",
        properties: {
          city: { type: "string" },
          units: { type: "string" }
        },
        required: ["city"]
      },
      targets: ["openai"]
    });

    const openai = report.providers[0];
    expect(openai?.provider).toBe("openai");
    expect(openai?.compatible).toBe(false);
    expect(openai?.normalizedSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["city", "units"]
    });
    expect(
      (openai?.normalizedSchema.properties as Record<string, unknown>).units
    ).toMatchObject({
      type: ["string", "null"]
    });
    expect(openai?.issues.some((issue) => issue.code === "openai_all_fields_must_be_required")).toBe(
      true
    );
  });

  it("adds Gemini propertyOrdering hints", async () => {
    const report = await lintStructuredOutputSchema({
      schema: {
        type: "object",
        properties: {
          city: { type: "string" },
          units: { type: "string" }
        },
        required: ["city", "units"],
        additionalProperties: false
      },
      targets: ["gemini"]
    });

    const gemini = report.providers[0];
    expect(gemini?.provider).toBe("gemini");
    expect(gemini?.compatible).toBe(true);
    expect(gemini?.normalizedSchema).toMatchObject({
      propertyOrdering: ["city", "units"]
    });
    expect(gemini?.issues.some((issue) => issue.code === "gemini_property_ordering_added")).toBe(
      true
    );
  });

  it("compiles provider-ready request fragments from the normalized schema", async () => {
    const bundle = await compileStructuredOutputSchema({
      schema: {
        type: "object",
        properties: {
          city: { type: "string" }
        },
        required: []
      },
      targets: ["openai", "gemini", "anthropic", "ollama"],
      name: "Weather Response",
      description: "Weather response payload"
    });

    expect(bundle.name).toBe("weather_response");

    const openai = bundle.providers.find((provider) => provider.provider === "openai");
    expect(openai?.variants[0]?.requestBody).toMatchObject({
      text: {
        format: {
          type: "json_schema",
          strict: true
        }
      }
    });

    const gemini = bundle.providers.find((provider) => provider.provider === "gemini");
    expect(gemini?.variants[0]?.requestBody).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json"
      }
    });

    const anthropic = bundle.providers.find((provider) => provider.provider === "anthropic");
    expect(anthropic?.variants[0]?.requestBody).toMatchObject({
      tool_choice: {
        type: "tool",
        name: "weather_response"
      }
    });

    const ollama = bundle.providers.find((provider) => provider.provider === "ollama");
    expect(ollama?.variants[0]?.requestBody).toMatchObject({
      format: {
        type: "object"
      },
      options: {
        temperature: 0
      }
    });
  });
});
