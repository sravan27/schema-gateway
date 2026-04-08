import { describe, expect, it } from "vitest";

import { lintStructuredOutputSchema } from "../src/index.js";

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
});
