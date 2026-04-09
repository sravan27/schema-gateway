export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Schema Gateway API",
    version: "0.1.1",
    description:
      "Prepaid machine-to-machine API for structured output normalization, repair, and signed responses."
  },
  servers: [
    {
      url: "https://schema-gateway.example"
    }
  ],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Worker status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    storage: { type: "string" },
                    ephemeralStorageAllowed: { type: "boolean" }
                  },
                  required: ["ok", "storage", "ephemeralStorageAllowed"]
                }
              }
            }
          }
        }
      }
    },
    "/v1/access/redeem": {
      post: {
        summary: "Redeem an on-chain purchase receipt for an API key",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  txHash: {
                    type: "string",
                    pattern: "^0x[a-fA-F0-9]{64}$"
                  },
                  label: {
                    type: "string",
                    minLength: 3,
                    maxLength: 64
                  },
                  chainId: {
                    type: "integer"
                  }
                },
                required: ["txHash", "label"]
              }
            }
          }
        },
        responses: {
          "201": {
            description: "A newly issued API key and credit balance"
          },
          "409": {
            description: "The transaction has already been redeemed"
          }
        }
      }
    },
    "/v1/access/polar/claim": {
      post: {
        summary: "Claim paid access for a Polar order",
        description:
          "Returns either a stateless signed access key or a stored prepaid API key depending on how the Worker is configured.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  orderId: { type: "string" },
                  email: { type: "string", format: "email" }
                },
                required: ["orderId", "email"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Issued API key for the matching order"
          },
          "404": {
            description: "No claim record found for that order"
          }
        }
      }
    },
    "/v1/webhooks/polar": {
      post: {
        summary: "Receive Polar billing webhooks",
        description:
          "Validates webhook signatures and provisions API claims for paid orders when the webhook-backed KV flow is enabled.",
        responses: {
          "202": {
            description: "Webhook accepted"
          },
          "403": {
            description: "Invalid webhook signature"
          }
        }
      }
    },
    "/v1/normalize": {
      post: {
        summary: "Normalize a provider payload against a JSON Schema",
        security: [{ apiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  provider: {
                    type: "string",
                    enum: ["generic", "openai", "langchain", "ollama"]
                  },
                  schema: {
                    type: "object",
                    additionalProperties: true
                  },
                  payload: {}
                },
                required: ["schema", "payload"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Signed normalization result"
          },
          "401": {
            description: "Missing or invalid API key"
          },
          "402": {
            description: "API key has no credits remaining"
          }
        }
      }
    },
    "/v1/lint": {
      post: {
        summary: "Lint a schema for provider portability",
        description:
          "Returns provider-specific compatibility diagnostics and auto-rewritten schema variants for OpenAI, Gemini, Anthropic, and Ollama.",
        security: [{ apiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  schema: {
                    type: "object",
                    additionalProperties: true
                  },
                  targets: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["openai", "gemini", "anthropic", "ollama"]
                    }
                  }
                },
                required: ["schema"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Signed portability report"
          },
          "401": {
            description: "Missing or invalid API key"
          },
          "402": {
            description: "API key has no credits remaining"
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      apiKeyHeader: {
        type: "apiKey",
        in: "header",
        name: "x-api-key"
      }
    }
  }
} as const;
